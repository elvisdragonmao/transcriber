import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import type { Scheduler } from "../queue/scheduler.js";
import type { UploadService } from "../uploads/service.js";
import type { RecordingService } from "../recordings/service.js";
import { SpeakerService } from "../speakers/service.js";
import { settingsSchema } from "../settings.js";
import { queryGpus, defaultMapping } from "../workers/gpu.js";
import { ObsidianService } from "../obsidian/service.js";
import { AppError, badRequest, nowIso, uuid } from "../lib/util.js";
import { validateVaultPath, joinVault } from "../obsidian/paths.js";
import { schemaVersion } from "../db/index.js";
import { runFfmpeg } from "../stages/prepare.js";
import { StageSignal } from "../workers/pool.js";

const id = z.object({ id: z.string().uuid() });

export function registerAdminRoutes(app: FastifyInstance, ctx: AppContext, scheduler: Scheduler, uploads: UploadService, recordings: RecordingService) {
  const speakers = new SpeakerService(ctx);

  // ---- speakers ----------------------------------------------------------------
  app.get("/api/speakers", async () => ({ items: speakers.list() }));
  app.post("/api/speakers", async (req) => {
    const b = z.object({ name: z.string().min(1).max(100), notes: z.string().max(2000).optional() }).parse(req.body);
    return speakers.create(b.name, b.notes);
  });
  app.get("/api/speakers/calibration", async () => speakers.calibration());
  app.get("/api/speakers/:id", async (req) => speakers.detail(id.parse(req.params).id));
  app.patch("/api/speakers/:id", async (req) => {
    const b = z.object({ name: z.string().min(1).max(100).optional(), notes: z.string().max(2000).nullable().optional(), aliases: z.array(z.string().max(100)).max(20).optional() }).parse(req.body);
    return speakers.update(id.parse(req.params).id, b);
  });
  app.delete("/api/speakers/:id", async (req) => speakers.delete(id.parse(req.params).id));
  app.post("/api/speakers/:id/merge", async (req) => {
    const { into } = z.object({ into: z.string().uuid() }).parse(req.body);
    return speakers.merge(id.parse(req.params).id, into);
  });
  app.delete("/api/voiceprints/:id", async (req) => speakers.deleteEmbedding(id.parse(req.params).id));
  app.patch("/api/recording-speakers/:id", async (req) => {
    const b = z
      .object({ speakerId: z.string().uuid().nullable().optional(), newName: z.string().min(1).max(100).optional(), label: z.string().max(60).optional(), enroll: z.boolean().optional() })
      .parse(req.body);
    return speakers.assign(id.parse(req.params).id, b);
  });
  app.post("/api/speakers/:id/enroll-clip", { bodyLimit: 40 * 1024 * 1024 }, async (req) => {
    const { id: sid } = id.parse(req.params);
    speakers.detail(sid);
    const body = req.body as NodeJS.ReadableStream;
    const dir = path.join(ctx.paths.tmp, `clip-${uuid()}`);
    await fsp.mkdir(dir, { recursive: true });
    try {
      const src = path.join(dir, "clip.bin");
      await new Promise<void>((res, rej) => body.pipe(fs.createWriteStream(src)).on("finish", () => res()).on("error", rej));
      const wav = path.join(dir, "clip.wav");
      await runFfmpeg(ctx.config.ffmpeg, ["-y", "-i", src, "-t", "300", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav], 300_000, new StageSignal(), () => undefined);
      const st = await fsp.stat(wav);
      const ms = Math.floor(((st.size - 44) / 32000) * 1000);
      if (ms < 3000) throw badRequest("Clip must contain at least 3 seconds of speech");
      const r: any = await ctx.workers.call("cpu", "embed", { audio_path: wav, speakers: { clip: [[0, ms]] }, model: ctx.settings.get().identify.model }, { timeoutMs: 120_000 });
      const e = r.speakers?.clip;
      if (!e?.embedding) throw badRequest("Could not extract a voiceprint from the clip");
      return speakers.addClipEmbedding(sid, e.embedding, e.used_ms, r.model_version);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  // ---- projects -----------------------------------------------------------------
  app.get("/api/projects", async () => ({ items: ctx.db.prepare("SELECT * FROM projects ORDER BY name COLLATE NOCASE").all() }));
  app.post("/api/projects", async (req) => {
    const b = z.object({ name: z.string().min(1).max(100), vaultFolder: z.string().max(300).nullable().optional(), kind: z.enum(["project", "course", "other"]).default("project") }).parse(req.body);
    if (b.vaultFolder) validateVaultPath(joinVault(b.vaultFolder, "x.md"), ctx.settings.get().obsidian.allowedRoots);
    const pid = uuid();
    ctx.db.prepare("INSERT INTO projects (id, name, vault_folder, kind, source, created_at, updated_at) VALUES (?, ?, ?, ?, 'manual', ?, ?)").run(pid, b.name, b.vaultFolder ?? null, b.kind, nowIso(), nowIso());
    return ctx.db.prepare("SELECT * FROM projects WHERE id = ?").get(pid);
  });

  // ---- settings -------------------------------------------------------------------
  app.get("/api/settings", async () => ({ settings: ctx.settings.get() }));
  app.patch("/api/settings", async (req) => {
    const body = req.body as Record<string, unknown>;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw badRequest("Expected an object");
    const current = ctx.settings.get() as Record<string, any>;
    // Only the sections present in the body change; each is merged onto its current value and validated.
    const patchObj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body)) {
      if (!(k in current)) throw badRequest(`Unknown settings section: ${k}`);
      if (!v || typeof v !== "object") throw badRequest(`Section ${k} must be an object`);
      patchObj[k] = (settingsSchema.shape as any)[k].parse({ ...current[k], ...(v as object) });
    }
    const ob = patchObj.obsidian as any;
    if (ob) {
      for (const r of ob.allowedRoots) if (!r.trim() || r.includes("..") || r.startsWith("/")) throw badRequest(`Invalid allowed root: ${r}`);
      validateVaultPath(joinVault(ob.transcriptFolder, "x.md"), ob.allowedRoots);
      validateVaultPath(joinVault(ob.pendingFolder, "x.md"), ob.allowedRoots);
      if (ob.backend === "filesystem" && ob.vaultRoot && !path.isAbsolute(ob.vaultRoot)) throw badRequest("Vault root must be an absolute path");
    }
    const gpuChanged = patchObj.gpu && JSON.stringify(patchObj.gpu) !== JSON.stringify(current.gpu);
    const s = ctx.settings.update(patchObj as any);
    if (gpuChanged) await ctx.workers.restart();
    scheduler.kick();
    return { settings: s };
  });

  // ---- LLM ------------------------------------------------------------------------
  app.get("/api/llm/status", async (req) => {
    const { refresh } = z.object({ refresh: z.coerce.boolean().optional() }).parse(req.query);
    const s = ctx.settings.get().llm;
    return { providers: await ctx.llm.status(refresh), settings: s, callsToday: ctx.llm.callsToday() };
  });
  app.post("/api/llm/test", async (req) => {
    const b = z.object({ provider: z.enum(["claude", "codex"]), model: z.string().max(100), effort: z.string().max(20) }).parse(req.body);
    const p = ctx.settings.get().llm[b.provider];
    if (b.model && !p.models.includes(b.model) && b.model !== p.model) throw badRequest("Add the model to the provider's model list first");
    return ctx.llm.test(b.provider, b.model, b.effort);
  });
  app.get("/api/llm/usage", async () => ({ items: ctx.llm.usage() }));

  // ---- Obsidian -------------------------------------------------------------------
  app.get("/api/obsidian/status", async () => ctx.obsidian.status());
  app.get("/api/obsidian/detect", async () => ({
    local: await ObsidianService.detectLocalVaults([os.homedir(), "/mnt", "/media", "/srv"].filter((p) => fs.existsSync(p))),
    livesyncAvailable: !!(ctx.config.obsidianMcpUrl && ctx.config.obsidianMcpToken),
  }));
  app.get("/api/obsidian/folders", async () => {
    const b = ctx.obsidian.backend();
    if (!b) throw new AppError(409, "vault_not_configured", "Obsidian vault is not configured");
    const roots = ctx.settings.get().obsidian.allowedRoots;
    const all = await b.listFolders();
    return { items: all.filter((f) => roots.some((r) => f === r || f.startsWith(r + "/"))) };
  });
  app.get("/api/recordings/:id/exports", async (req) => ({ items: ctx.obsidian.listExports(id.parse(req.params).id) }));
  app.post("/api/recordings/:id/obsidian", async (req) => {
    const { id: rid } = id.parse(req.params);
    const b = z.object({ overwrite: z.boolean().default(false) }).parse(req.body ?? {});
    const r = await ctx.obsidian.exportTranscript(rid, b);
    ctx.events.publish("recording.updated", { id: rid });
    return r;
  });
  app.post("/api/notes/:id/obsidian", async (req) => {
    const { id: nid } = id.parse(req.params);
    const b = z.object({ folder: z.string().max(400).optional(), overwrite: z.boolean().default(false) }).parse(req.body ?? {});
    const r = b.folder ? await ctx.obsidian.moveNote(nid, b.folder) : await ctx.obsidian.exportNote(nid, { overwrite: b.overwrite });
    const note = ctx.db.prepare("SELECT recording_id FROM generated_notes WHERE id = ?").get(nid) as any;
    // keep the transcript's "related notes" links current
    await ctx.obsidian.exportTranscript(note.recording_id).catch(() => undefined);
    ctx.events.publish("recording.updated", { id: note.recording_id });
    return r;
  });
  app.get("/api/obsidian/exports/:id", async (req) => ctx.obsidian.readExport(id.parse(req.params).id));
  app.delete("/api/obsidian/exports/:id", async (req) => {
    const b = z.object({ confirm: z.string() }).parse(req.body ?? {});
    if (b.confirm !== "DELETE OBSIDIAN FILE") throw badRequest('Requires confirm: "DELETE OBSIDIAN FILE"');
    return ctx.obsidian.deleteExportedFile(id.parse(req.params).id);
  });

  // ---- system -----------------------------------------------------------------------
  app.get("/api/system/gpus", async () => {
    const { gpus, error } = await queryGpus();
    return { gpus, error, mapping: ctx.settings.get().gpu, suggested: defaultMapping(gpus) };
  });
  app.get("/api/system/status", async () => {
    const { gpus, error } = await queryGpus();
    const counts = Object.fromEntries((ctx.db.prepare("SELECT status, COUNT(*) AS n FROM jobs GROUP BY status").all() as any[]).map((r) => [r.status, r.n]));
    return {
      version: "0.1.0",
      node: process.version,
      uptimeSec: Math.round(process.uptime()),
      schemaVersion: schemaVersion(ctx.db),
      gpus,
      gpuError: error,
      mapping: ctx.settings.get().gpu,
      workers: ctx.workers.status(),
      running: scheduler.runningSummary(),
      jobCounts: counts,
      storage: await recordings.storage(),
      mockWorker: ctx.config.mockWorker,
      lanOnly: ctx.config.lanOnly,
      loadavg: os.loadavg(),
      memory: { total: os.totalmem(), free: os.freemem() },
    };
  });
  app.post("/api/system/diagnostics", async () => {
    const out: Record<string, unknown> = {};
    for (const lane of ["gpu-asr", "gpu-diar", "cpu"] as const) {
      try {
        out[lane] = await ctx.workers.call(lane, "health", {}, { timeoutMs: 120_000 });
      } catch (e: any) {
        out[lane] = { error: e.message, code: e.code };
      }
    }
    return out;
  });
  app.post("/api/system/cleanup", async (req) => {
    const b = z.object({ uploads: z.boolean().default(true), intermediates: z.boolean().default(false), olderThanDays: z.number().int().min(0).max(3650).optional() }).parse(req.body ?? {});
    const s = ctx.settings.get().storage;
    const res: Record<string, unknown> = {};
    if (b.uploads) res.uploads = await uploads.cleanup(0);
    if (b.intermediates) res.intermediates = await recordings.cleanupIntermediates(b.olderThanDays ?? s.cleanupIntermediatesDays);
    return res;
  });
  app.post("/api/system/workers/restart", async () => {
    if (scheduler.runningSummary().some((r) => r.lane !== "node" && r.lane !== "llm" && r.lane !== "ffmpeg")) throw new AppError(409, "busy", "Workers are busy; pause jobs first");
    await ctx.workers.restart();
    return { ok: true };
  });
  app.get("/api/system/logs", async (req) => {
    const { name, lines } = z.object({ name: z.enum(["server", "worker-cpu", "worker-gpu-asr", "worker-gpu-diar"]), lines: z.coerce.number().int().min(10).max(2000).default(300) }).parse(req.query);
    const file = path.join(ctx.paths.logs, `${name}.log`);
    if (!fs.existsSync(file)) return { name, lines: [] };
    const st = await fsp.stat(file);
    const fh = await fsp.open(file, "r");
    const size = Math.min(st.size, 512 * 1024);
    const buf = Buffer.alloc(size);
    await fh.read(buf, 0, size, st.size - size);
    await fh.close();
    return { name, lines: buf.toString("utf8").split("\n").slice(-lines) };
  });
}
