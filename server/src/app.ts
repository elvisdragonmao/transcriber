import fs from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { ZodError } from "zod";
import { dataPaths, type AppConfig } from "./config.js";
import { openDb, type DB } from "./db/index.js";
import { SettingsStore } from "./settings.js";
import { EventBus } from "./events.js";
import { PythonWorkerPool, type Lane, type WorkerPoolLike } from "./workers/pool.js";
import { MockWorkerPool } from "./workers/mock.js";
import { LlmService } from "./llm/service.js";
import { ObsidianService } from "./obsidian/service.js";
import { Scheduler } from "./queue/scheduler.js";
import { UploadService } from "./uploads/service.js";
import { RecordingService, recordingFactory } from "./recordings/service.js";
import { ensureAdmin, originCheck, registerAuth, requireAuth } from "./auth/auth.js";
import { registerCoreRoutes } from "./routes/core.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { AppError } from "./lib/util.js";
import type { AppContext } from "./context.js";
import type { LlmAdapter } from "./llm/adapters.js";
import type { VaultBackend } from "./obsidian/backends.js";
import { queryGpus, defaultMapping } from "./workers/gpu.js";

export interface BuildOptions {
  workers?: WorkerPoolLike;
  llmAdapters?: Partial<Record<"claude" | "codex", LlmAdapter>>;
  vaultBackend?: VaultBackend;
  logger?: boolean;
  startScheduler?: boolean;
}

export interface BuiltApp {
  app: FastifyInstance;
  ctx: AppContext;
  scheduler: Scheduler;
  uploads: UploadService;
  recordings: RecordingService;
  close: () => Promise<void>;
}

const PRIVATE_NET = [/^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^::1$/, /^fc|^fd/i, /^fe80:/i, /^::ffff:(127|10|192\.168)\./];

export async function buildApp(config: AppConfig, opts: BuildOptions = {}): Promise<BuiltApp> {
  const paths = dataPaths(config.dataDir);
  for (const d of Object.values(paths)) if (!d.endsWith(".sqlite")) fs.mkdirSync(d, { recursive: true });
  const db: DB = openDb(paths.db);
  const settings = new SettingsStore(db);
  const events = new EventBus();

  const logStream = opts.logger === false ? null : fs.createWriteStream(path.join(paths.logs, "server.log"), { flags: "a" });
  const app = Fastify({
    trustProxy: config.trustProxy,
    bodyLimit: 2 * 1024 * 1024,
    logger:
      opts.logger === false
        ? false
        : {
            level: config.logLevel,
            stream: { write: (s: string) => (process.stdout.write(s), logStream!.write(s)) } as any,
            redact: { paths: ["req.headers.cookie", "req.headers.authorization", "req.body", "res.headers['set-cookie']"], censor: "[redacted]" },
            serializers: {
              req: (r) => ({ method: r.method, url: r.url.replace(/\?.*$/, ""), ip: r.ip }),
            },
          },
  });

  // First boot: map GPUs by name (RTX 5060 → ASR, RTX 3050 → diarization), always by UUID.
  if (!settings.get().gpu.asrDevice && !config.mockWorker && !opts.workers) {
    const { gpus } = await queryGpus(0);
    if (gpus.length) settings.update({ gpu: defaultMapping(gpus) });
  }

  const laneConfig = (lane: Lane) => {
    const g = settings.get().gpu;
    const device = lane === "gpu-asr" ? g.asrDevice : lane === "gpu-diar" ? (g.diarDevice === "cpu" ? "" : g.diarDevice) : "";
    return {
      device,
      env: {
        IDLE_UNLOAD_S: String(g.idleUnloadSec),
        CO_RESIDENT: g.coResident,
        ...(config.hfHome ? { HF_HOME: config.hfHome } : {}),
        OMP_NUM_THREADS: lane === "cpu" ? "6" : "4",
      },
    };
  };
  const workers = opts.workers ?? (config.mockWorker ? new MockWorkerPool() : new PythonWorkerPool(config.workerPython, config.workerDir, paths.logs, laneConfig));
  const llm = new LlmService(db, settings, { claudeBin: config.claudeBin, codexBin: config.codexBin, home: config.cliHome, sandbox: paths.llm }, opts.llmAdapters);
  const obsidian = new ObsidianService(db, settings, config, opts.vaultBackend);
  const ctx: AppContext = {
    db,
    config,
    paths,
    settings,
    events,
    workers,
    llm,
    obsidian,
    log: { info: (...a: any[]) => app.log.info(...(a as [any])), warn: (...a: any[]) => app.log.warn(...(a as [any])), error: (...a: any[]) => app.log.error(...(a as [any])) },
  };
  const scheduler = new Scheduler(ctx);
  const recordings = new RecordingService(ctx);
  const uploads = new UploadService(db, paths, () => settings.get(), recordingFactory(ctx));

  await app.register(cookie);
  app.addContentTypeParser("application/octet-stream", (_req, payload, done) => done(null, payload));
  app.addContentTypeParser(/^audio\/.*|^video\/.*/, (_req, payload, done) => done(null, payload));

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof ZodError) return reply.status(400).send({ error: "bad_request", message: "Invalid request", issues: err.issues.slice(0, 10) });
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: err.code, message: err.message, details: err.details });
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: err.code ?? "error", message: err.message });
    req.log.error({ err: { message: err.message, stack: err.stack } }, "unhandled error");
    return reply.status(500).send({ error: "internal", message: "Internal server error" });
  });

  // Optional LAN-only mode: refuse requests whose client address is not private/CGNAT (WARP is 100.64/10).
  if (config.lanOnly)
    app.addHook("onRequest", async (req) => {
      if (!PRIVATE_NET.some((re) => re.test(req.ip))) throw new AppError(403, "lan_only", "This service is only available on the local network");
    });

  // Security headers + strict CORS: API is same-origin only unless ALLOWED_ORIGINS lists a peer.
  app.addHook("onSend", async (req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "same-origin");
    reply.header("X-Frame-Options", "DENY");
    if (!req.url.startsWith("/api/"))
      reply.header("Content-Security-Policy", "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'");
    const origin = req.headers.origin;
    if (origin && config.allowedOrigins.includes(origin)) {
      reply.header("Access-Control-Allow-Origin", origin);
      reply.header("Access-Control-Allow-Credentials", "true");
      reply.header("Vary", "Origin");
    }
  });
  app.options("/api/*", async (req, reply) => {
    const origin = req.headers.origin;
    if (!origin || !config.allowedOrigins.includes(origin)) return reply.status(403).send();
    return reply
      .header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE")
      .header("Access-Control-Allow-Headers", "content-type,x-chunk-sha256")
      .status(204)
      .send();
  });

  registerAuth(app, db, config);
  app.get("/api/health", async () => ({ ok: true, time: new Date().toISOString() }));

  await app.register(async (api) => {
    api.addHook("onRequest", originCheck(config));
    api.addHook("onRequest", requireAuth);
    registerCoreRoutes(api, ctx, scheduler, uploads, recordings);
    registerAdminRoutes(api, ctx, scheduler, uploads, recordings);

    // ---- SSE: live job progress; resumable via Last-Event-ID within the same server epoch
    api.get("/api/events", async (req, reply) => {
      const lastId = String(req.headers["last-event-id"] ?? (req.query as any)?.lastEventId ?? "");
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      const send = (ev: { seq: number; type: string; data: unknown }) => res.write(`id: ${events.epoch}:${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev.data)}\n\n`);
      res.write(`retry: 3000\n\n`);
      const [epoch, seqStr] = lastId.split(":");
      const missed = epoch === events.epoch ? events.since(Number(seqStr) || 0) : null;
      if (missed) missed.forEach(send);
      else res.write(`id: ${events.epoch}:${events.lastSeq}\nevent: resync\ndata: {}\n\n`);
      const unsub = events.subscribe(send);
      const ping = setInterval(() => res.write(`: ping ${Date.now()}\n\n`), 15000);
      req.raw.on("close", () => {
        clearInterval(ping);
        unsub();
      });
    });
  });

  const webDist = path.join(config.projectRoot, "web", "dist");
  if (fs.existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, prefix: "/", wildcard: true, index: ["index.html"] });
    app.setNotFoundHandler((req, reply) => {
      // unknown API routes and missing build assets are real 404s; everything else is an SPA route
      if (req.url.startsWith("/api/") || req.url.startsWith("/assets/")) return reply.status(404).send({ error: "not_found", message: "Not found" });
      return reply.type("text/html").header("Cache-Control", "no-cache").sendFile("index.html", webDist);
    });
  } else {
    await app.register(fastifyStatic, { root: paths.recordings, serve: false });
  }

  await ensureAdmin(db, config, (m) => app.log.warn(m));
  if (opts.startScheduler !== false) scheduler.start();

  // periodic housekeeping: expired upload chunks, and intermediate model outputs of finished
  // recordings older than the configured age (0 disables; transcripts themselves live in SQLite)
  const housekeeping = setInterval(() => {
    const st = settings.get().storage;
    uploads.cleanup(st.cleanupFailedUploadsHours).catch(() => undefined);
    if (st.cleanupIntermediatesDays > 0) recordings.cleanupIntermediates(st.cleanupIntermediatesDays).catch(() => undefined);
  }, 3600_000);

  return {
    app,
    ctx,
    scheduler,
    uploads,
    recordings,
    close: async () => {
      clearInterval(housekeeping);
      await scheduler.stop();
      await app.close();
      await workers.shutdown();
      db.close();
      logStream?.end();
    },
  };
}
