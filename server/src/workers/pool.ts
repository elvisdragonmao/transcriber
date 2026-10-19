import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import fs from "node:fs";
import { uuid } from "../lib/util.js";

export type Lane = "cpu" | "gpu-asr" | "gpu-diar";

export interface Progress {
  done: number;
  total: number | null;
  unit: string;
  detail?: Record<string, unknown>;
}

export interface CallOptions {
  onProgress?: (p: Progress) => void;
  onLog?: (level: string, message: string) => void;
  signal?: StageSignal;
  /** Hard ceiling; on expiry the worker process is killed (frees GPU memory). */
  timeoutMs?: number;
}

/** Cooperative control for a running stage. */
export class StageSignal {
  reason: "pause" | "cancel" | null = null;
  private listeners: ((r: "pause" | "cancel") => void)[] = [];
  request(reason: "pause" | "cancel") {
    if (this.reason === "cancel") return;
    this.reason = reason;
    for (const l of this.listeners) l(reason);
  }
  on(fn: (r: "pause" | "cancel") => void) {
    this.listeners.push(fn);
  }
}

export class WorkerCallError extends Error {
  constructor(
    public code: string,
    message: string,
    public retryable: boolean,
  ) {
    super(message);
  }
}

export interface WorkerPoolLike {
  call<T = any>(lane: Lane, op: string, params: Record<string, unknown>, opts?: CallOptions): Promise<T>;
  status(): Record<string, { running: boolean; pid: number | null; busy: boolean; device: string; startedAt: string | null; lastError: string | null }>;
  restart(lane?: Lane): Promise<void>;
  shutdown(): Promise<void>;
}

interface LaneConfig {
  device: string; // CUDA_VISIBLE_DEVICES value: GPU UUID, or "" for CPU
  env?: Record<string, string>;
}

interface Pending {
  id: string;
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  opts: CallOptions;
  timer?: NodeJS.Timeout;
}

/** One long-lived Python process per lane; exactly one call in flight per lane. */
class LaneWorker {
  proc: ChildProcessWithoutNullStreams | null = null;
  ready: Promise<void> | null = null;
  pending: Pending | null = null;
  /** Serialises calls: each call starts only after the previous one settled. */
  private chain: Promise<unknown> = Promise.resolve();
  startedAt: string | null = null;
  lastError: string | null = null;
  private stderrTail: string[] = [];

  constructor(
    readonly lane: Lane,
    private python: string,
    private cwd: string,
    private cfg: () => LaneConfig,
    private logFile: string,
  ) {}

  get busy() {
    return this.pending !== null;
  }

  private start(): Promise<void> {
    const { device, env } = this.cfg();
    fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
    const log = fs.createWriteStream(this.logFile, { flags: "a" });
    const proc = spawn(this.python, ["-m", "transcriber_worker", "--lane", this.lane], {
      cwd: this.cwd,
      env: {
        ...process.env,
        ...env,
        CUDA_VISIBLE_DEVICES: device,
        CUDA_DEVICE_ORDER: "PCI_BUS_ID",
        PYTHONUNBUFFERED: "1",
        TOKENIZERS_PARALLELISM: "false",
        HF_HUB_DISABLE_TELEMETRY: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;
    this.startedAt = new Date().toISOString();
    proc.stderr.on("data", (d: Buffer) => {
      log.write(d);
      const lines = d.toString().split("\n").filter(Boolean);
      this.stderrTail.push(...lines);
      if (this.stderrTail.length > 40) this.stderrTail.splice(0, this.stderrTail.length - 40);
    });
    const ready = new Promise<void>((resolve, reject) => {
      const rl = readline.createInterface({ input: proc.stdout });
      let isReady = false;
      rl.on("line", (line) => {
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        if (msg.type === "ready") {
          isReady = true;
          resolve();
          return;
        }
        this.onMessage(msg);
      });
      proc.on("exit", (code, sig) => {
        log.end();
        this.proc = null;
        this.ready = null;
        const why = `worker ${this.lane} exited (code ${code}, signal ${sig})`;
        this.lastError = `${why}: ${this.stderrTail.slice(-5).join(" | ")}`.slice(0, 2000);
        if (!isReady) reject(new WorkerCallError("WORKER_START_FAILED", this.lastError, true));
        if (this.pending) {
          const p = this.pending;
          this.pending = null;
          clearTimeout(p.timer);
          const cancelled = p.opts.signal?.reason === "cancel";
          const paused = p.opts.signal?.reason === "pause";
          if (cancelled) p.reject(new WorkerCallError("CANCELLED", "cancelled", false));
          else if (paused) p.resolve({ status: "paused" });
          else p.reject(new WorkerCallError("WORKER_CRASHED", this.lastError, true));
        }
      });
      proc.on("error", (e) => reject(new WorkerCallError("WORKER_START_FAILED", String(e), false)));
    });
    this.ready = ready;
    return ready;
  }

  private onMessage(msg: any) {
    const p = this.pending;
    if (!p || msg.id !== p.id) return;
    if (msg.type === "progress") p.opts.onProgress?.({ done: msg.done, total: msg.total, unit: msg.unit, detail: msg.detail });
    else if (msg.type === "log") p.opts.onLog?.(msg.level, msg.message);
    else if (msg.type === "result") {
      this.finish();
      p.resolve(msg.result);
    } else if (msg.type === "error") {
      this.finish();
      p.reject(new WorkerCallError(msg.code, msg.message, !!msg.retryable));
    }
  }

  private finish() {
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = null;
  }

  private send(obj: unknown) {
    this.proc?.stdin.write(JSON.stringify(obj) + "\n");
  }

  call<T>(op: string, params: Record<string, unknown>, opts: CallOptions): Promise<T> {
    const run = this.chain.then(() => this.exec<T>(op, params, opts));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async exec<T>(op: string, params: Record<string, unknown>, opts: CallOptions): Promise<T> {
    if (opts.signal?.reason === "cancel") throw new WorkerCallError("CANCELLED", "cancelled before start", false);
    if (opts.signal?.reason === "pause") return { status: "paused" } as T;
    if (!this.proc) await this.start();
    else await this.ready;
    return new Promise<T>((resolve, reject) => {
      const id = uuid();
      const pending: Pending = { id, resolve, reject, opts };
      this.pending = pending;
      opts.signal?.on((reason) => {
        if (this.pending?.id !== id) return;
        this.send({ type: "control", id, action: reason });
        if (reason === "cancel") {
          // Give the worker a moment to stop at a boundary, then kill it (frees GPU memory).
          setTimeout(() => {
            if (this.pending?.id === id) this.kill("SIGTERM");
          }, 15_000);
        }
      });
      if (opts.timeoutMs) {
        pending.timer = setTimeout(() => {
          if (this.pending?.id !== id) return;
          this.pending = null;
          this.kill("SIGKILL");
          reject(new WorkerCallError("TIMEOUT", `${op} exceeded ${Math.round(opts.timeoutMs! / 1000)} s`, true));
        }, opts.timeoutMs);
      }
      this.send({ type: "call", id, op, params });
    });
  }

  kill(sig: NodeJS.Signals = "SIGTERM") {
    const p = this.proc;
    if (!p) return;
    p.kill(sig);
    setTimeout(() => {
      if (this.proc === p) p.kill("SIGKILL");
    }, 5000);
  }

  async stop() {
    if (!this.proc) return;
    const p = this.proc;
    this.send({ type: "shutdown" });
    await new Promise<void>((r) => {
      const t = setTimeout(() => {
        p.kill("SIGKILL");
        r();
      }, 8000);
      p.once("exit", () => {
        clearTimeout(t);
        r();
      });
    });
  }
}

export class PythonWorkerPool implements WorkerPoolLike {
  private lanes = new Map<Lane, LaneWorker>();

  constructor(
    python: string,
    workerDir: string,
    logDir: string,
    laneConfig: (lane: Lane) => LaneConfig,
  ) {
    for (const lane of ["cpu", "gpu-asr", "gpu-diar"] as Lane[]) {
      this.lanes.set(lane, new LaneWorker(lane, python, workerDir, () => laneConfig(lane), path.join(logDir, `worker-${lane}.log`)));
    }
  }

  call<T = any>(lane: Lane, op: string, params: Record<string, unknown>, opts: CallOptions = {}): Promise<T> {
    return this.lanes.get(lane)!.call<T>(op, params, opts);
  }

  status() {
    const out: ReturnType<WorkerPoolLike["status"]> = {};
    for (const [lane, w] of this.lanes) {
      out[lane] = {
        running: !!w.proc,
        pid: w.proc?.pid ?? null,
        busy: w.busy,
        device: "",
        startedAt: w.startedAt,
        lastError: w.lastError,
      };
    }
    return out;
  }

  async restart(lane?: Lane) {
    for (const [l, w] of this.lanes) if (!lane || l === lane) await w.stop();
  }

  async shutdown() {
    await Promise.all([...this.lanes.values()].map((w) => w.stop()));
  }
}
