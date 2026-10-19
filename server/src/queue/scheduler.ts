import type { AppContext } from "../context.js";
import { AppError, json, nowIso } from "../lib/util.js";
import { StageSignal, WorkerCallError } from "../workers/pool.js";
import {
  assertTransition,
  computeJobProgress,
  getJob,
  getStages,
  jobSnapshot,
  removeWorkFiles,
  type JobRow,
  type StageRow,
} from "./jobs.js";
import { stageHandlers } from "../stages/index.js";
import type { StageOutcome } from "../stages/types.js";

import { CancelledError, FatalStageError } from "../lib/errors.js";
export { CancelledError, FatalStageError };

interface Running {
  stage: StageRow;
  signal: StageSignal;
  lastProgressAt: number;
  promise: Promise<void>;
}

const LEASE_MS = 60_000;

/**
 * GPU-aware scheduler. Every stage runs on a lane; each GPU lane runs one heavy stage
 * at a time, so uploading ten files never starts ten models on one card. Different
 * lanes (RTX 5060 ASR/alignment, RTX 3050 diarization, CPU) run in parallel, also
 * across different recordings. State lives in SQLite; the in-memory map only tracks
 * what this process is executing right now.
 */
export class Scheduler {
  private running = new Map<string, Running>();
  private timer: NodeJS.Timeout | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private ticking = false;
  private again = false;
  private stopped = false;
  private lastPublish = new Map<string, number>();
  private publishTimers = new Map<string, NodeJS.Timeout>();

  constructor(private ctx: AppContext) {}

  start() {
    this.recover();
    this.timer = setInterval(() => this.kick(), 2000);
    this.heartbeat = setInterval(() => this.renewLeases(), 10_000);
    this.kick();
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const r of this.running.values()) r.signal.request("pause");
    await Promise.race([Promise.allSettled([...this.running.values()].map((r) => r.promise)), new Promise((r) => setTimeout(r, 20_000))]);
  }

  /** On boot: nothing can be running, because workers are children of this process. */
  recover() {
    const db = this.ctx.db;
    const now = nowIso();
    db.transaction(() => {
      const stale = db.prepare("SELECT id, job_id, name FROM job_stages WHERE status = 'running'").all() as any[];
      for (const s of stale) {
        db.prepare("UPDATE job_stages SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL, rate_started_at = NULL, updated_at = ? WHERE id = ?").run(now, s.id);
        this.event(s.job_id, s.name, "warn", "recovered", "Stage was running when the server stopped; it will resume from its last checkpoint");
      }
      db.prepare("UPDATE jobs SET status = 'queued', updated_at = ? WHERE status = 'running'").run(now);
      db.prepare("UPDATE jobs SET status = 'paused', updated_at = ? WHERE status = 'pausing'").run(now);
      const cancelling = db.prepare("SELECT id FROM jobs WHERE status = 'cancelling'").all() as any[];
      for (const j of cancelling) this.finalizeCancel(j.id);
    })();
  }

  private renewLeases() {
    const until = new Date(Date.now() + LEASE_MS).toISOString();
    const stmt = this.ctx.db.prepare("UPDATE job_stages SET lease_expires_at = ? WHERE id = ? AND lease_owner = ?");
    const stallMs = this.ctx.settings.get().queue.stallTimeoutSec * 1000;
    for (const r of this.running.values()) {
      stmt.run(until, r.stage.id, this.ctx.config.instanceId);
      if (Date.now() - r.lastProgressAt > stallMs && !r.signal.reason) {
        this.event(r.stage.job_id, r.stage.name, "warn", "stalled", `No progress for ${Math.round(stallMs / 1000)} s; restarting stage`);
        (r as any).stalled = true;
        r.signal.request("cancel");
      }
    }
    // Leases held by a different, dead instance (e.g. after a crash with a shared DB) are reclaimed.
    const expired = this.ctx.db
      .prepare("SELECT id, job_id, name FROM job_stages WHERE status = 'running' AND lease_expires_at < ? AND (lease_owner IS NULL OR lease_owner != ?)")
      .all(nowIso(), this.ctx.config.instanceId) as any[];
    for (const s of expired) {
      this.ctx.db.prepare("UPDATE job_stages SET status = 'pending', lease_owner = NULL, updated_at = ? WHERE id = ?").run(nowIso(), s.id);
      this.event(s.job_id, s.name, "warn", "lease_expired", "Worker lease expired; stage requeued");
    }
  }

  kick() {
    if (this.stopped) return;
    if (this.ticking) {
      this.again = true;
      return;
    }
    this.ticking = true;
    try {
      this.tick();
    } catch (e) {
      this.ctx.log.error({ err: e }, "scheduler tick failed");
    } finally {
      this.ticking = false;
      if (this.again) {
        this.again = false;
        setImmediate(() => this.kick());
      }
    }
  }

  private laneCapacity(lane: string): number {
    const s = this.ctx.settings.get();
    switch (lane) {
      case "gpu-asr":
      case "gpu-diar":
      case "cpu": // one Python CPU worker process
        return 1;
      case "ffmpeg":
        return s.queue.cpuConcurrency;
      case "llm":
        return s.queue.llmConcurrency;
      default:
        return 64;
    }
  }

  private tick() {
    const db = this.ctx.db;
    const busy = new Map<string, number>();
    for (const r of this.running.values()) busy.set(r.stage.lane, (busy.get(r.stage.lane) ?? 0) + 1);

    const candidates = db
      .prepare(
        `SELECT s.* FROM job_stages s JOIN jobs j ON j.id = s.job_id
         WHERE s.status = 'pending' AND j.status IN ('queued','running') AND (s.next_attempt_at IS NULL OR s.next_attempt_at <= ?)
         ORDER BY j.created_at ASC, s.seq ASC`,
      )
      .all(nowIso()) as StageRow[];
    const stageStatus = new Map<string, Map<string, string>>();
    const statusesFor = (jobId: string) => {
      let m = stageStatus.get(jobId);
      if (!m) {
        m = new Map((db.prepare("SELECT name, status FROM job_stages WHERE job_id = ?").all(jobId) as any[]).map((r) => [r.name, r.status]));
        stageStatus.set(jobId, m);
      }
      return m;
    };
    for (const st of candidates) {
      if (this.running.has(st.id)) continue;
      const statuses = statusesFor(st.job_id);
      const deps = json<string[]>(st.depends_on, []);
      if (!deps.every((d) => ["completed", "skipped"].includes(statuses.get(d) ?? "completed"))) continue;
      const used = busy.get(st.lane) ?? 0;
      if (used >= this.laneCapacity(st.lane)) continue;
      if (this.launch(st)) {
        busy.set(st.lane, used + 1);
        statuses.set(st.name, "running");
      }
    }
    this.settleJobs();
  }

  private launch(st: StageRow): boolean {
    const db = this.ctx.db;
    const now = nowIso();
    // Claim atomically: protects against double start (two ticks, two processes).
    const claimed = db
      .prepare(
        `UPDATE job_stages SET status = 'running', lease_owner = ?, lease_expires_at = ?, started_at = COALESCE(started_at, ?),
           rate_started_at = ?, rate_base_done = progress_done, error = NULL, error_code = NULL, updated_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(this.ctx.config.instanceId, new Date(Date.now() + LEASE_MS).toISOString(), now, now, now, st.id);
    if (claimed.changes === 0) return false;
    db.prepare(
      "UPDATE jobs SET status = 'running', current_stage = ?, started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ? AND status IN ('queued','running')",
    ).run(st.name, now, now, st.job_id);
    const stage = db.prepare("SELECT * FROM job_stages WHERE id = ?").get(st.id) as StageRow;
    const signal = new StageSignal();
    const entry: Running = { stage, signal, lastProgressAt: Date.now(), promise: Promise.resolve() };
    this.running.set(st.id, entry);
    this.event(st.job_id, st.name, "info", "stage_started", `${st.name} started (attempt ${st.retry_count + 1})`);
    this.publishJob(st.job_id, true);
    entry.promise = this.execute(entry).finally(() => {
      this.running.delete(st.id);
      this.kick();
    });
    return true;
  }

  private async execute(r: Running) {
    const db = this.ctx.db;
    const st = r.stage;
    const handler = stageHandlers[st.name];
    const job = getJob(db, st.job_id);
    let outcome: StageOutcome;
    try {
      if (!handler) throw new FatalStageError("NO_HANDLER", `No handler for stage ${st.name}`);
      outcome = await handler({
        app: this.ctx,
        job,
        stage: st,
        signal: r.signal,
        progress: (done, total, unit, detail) => this.progress(r, done, total, unit, detail),
        log: (level, msg, data) => this.event(st.job_id, st.name, level, "log", msg, data),
        setLane: (lane) => {
          db.prepare("UPDATE job_stages SET lane = ? WHERE id = ?").run(lane, st.id);
          r.stage.lane = lane;
        },
      });
    } catch (e: any) {
      this.onStageError(r, e);
      return;
    }
    const now = nowIso();
    if (outcome.kind === "paused") {
      db.prepare("UPDATE job_stages SET status = 'pending', lease_owner = NULL, rate_started_at = NULL, updated_at = ? WHERE id = ?").run(now, st.id);
      this.event(st.job_id, st.name, "info", "stage_paused", `${st.name} paused at a safe boundary`);
    } else {
      db.prepare(
        `UPDATE job_stages SET status = ?, progress = CASE WHEN ? = 'completed' THEN 1 ELSE progress END, ended_at = ?, lease_owner = NULL,
           output_path = COALESCE(?, output_path), model_version = COALESCE(?, model_version), progress_detail = COALESCE(?, progress_detail), updated_at = ? WHERE id = ?`,
      ).run(
        outcome.kind,
        outcome.kind,
        now,
        outcome.outputPath ?? null,
        outcome.modelVersion ?? null,
        outcome.detail ? JSON.stringify(outcome.detail) : null,
        now,
        st.id,
      );
      this.event(st.job_id, st.name, "info", outcome.kind === "skipped" ? "stage_skipped" : "stage_completed", outcome.message ?? `${st.name} ${outcome.kind}`);
    }
    this.publishJob(st.job_id, true);
  }

  private onStageError(r: Running, e: any) {
    const db = this.ctx.db;
    const st = db.prepare("SELECT * FROM job_stages WHERE id = ?").get(r.stage.id) as StageRow;
    const now = nowIso();
    const stalled = (r as any).stalled;
    const stopped = e instanceof CancelledError || (e instanceof WorkerCallError && e.code === "CANCELLED");
    const cancelled = !stalled && (r.signal.reason === "cancel" || (stopped && r.signal.reason !== "pause"));
    if (cancelled) {
      db.prepare("UPDATE job_stages SET status = 'cancelled', ended_at = ?, lease_owner = NULL, updated_at = ? WHERE id = ?").run(now, now, st.id);
      this.event(st.job_id, st.name, "info", "stage_cancelled", `${st.name} cancelled`);
      this.publishJob(st.job_id, true);
      return;
    }
    if (r.signal.reason === "pause" && !(e instanceof FatalStageError)) {
      db.prepare("UPDATE job_stages SET status = 'pending', lease_owner = NULL, updated_at = ? WHERE id = ?").run(now, st.id);
      this.publishJob(st.job_id, true);
      return;
    }
    const code = stalled ? "STALLED" : e instanceof WorkerCallError || e instanceof FatalStageError ? e.code : e?.code === "ENOSPC" ? "NO_SPACE" : "ERROR";
    const clientError = e instanceof AppError && e.statusCode < 500;
    const retryable = !(e instanceof FatalStageError) && !clientError && (stalled || (e instanceof WorkerCallError ? e.retryable : !["NO_SPACE", "BAD_INPUT"].includes(code)));
    const message = String(e?.message ?? e).slice(0, 2000);
    if (retryable && st.retry_count < st.max_retries) {
      const delay = Math.min(300, 10 * 2 ** st.retry_count);
      db.prepare(
        `UPDATE job_stages SET status = 'pending', retry_count = retry_count + 1, error = ?, error_code = ?, next_attempt_at = ?, lease_owner = NULL, updated_at = ? WHERE id = ?`,
      ).run(message, code, new Date(Date.now() + delay * 1000).toISOString(), now, st.id);
      this.event(st.job_id, st.name, "warn", "stage_retry", `${st.name} failed (${code}); retrying in ${delay} s`, { message });
    } else {
      db.prepare("UPDATE job_stages SET status = 'failed', error = ?, error_code = ?, ended_at = ?, lease_owner = NULL, updated_at = ? WHERE id = ?").run(
        message,
        code,
        now,
        now,
        st.id,
      );
      db.prepare("UPDATE jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ? AND status NOT IN ('cancelled','cancelling')").run(
        `${st.name}: ${message}`.slice(0, 2000),
        now,
        st.job_id,
      );
      this.event(st.job_id, st.name, "error", "stage_failed", `${st.name} failed (${code})`, { message });
    }
    this.publishJob(st.job_id, true);
  }

  private progress(r: Running, done: number, total: number | null, unit: string, detail?: Record<string, unknown>) {
    r.lastProgressAt = Date.now();
    const p = total && total > 0 ? Math.max(0, Math.min(1, done / total)) : null;
    this.ctx.db
      .prepare("UPDATE job_stages SET progress = ?, progress_done = ?, progress_total = ?, progress_unit = ?, progress_detail = COALESCE(?, progress_detail), updated_at = ? WHERE id = ?")
      .run(p, done, total, unit, detail ? JSON.stringify(detail) : null, nowIso(), r.stage.id);
    this.publishJob(r.stage.job_id);
  }

  /** Close out jobs whose stages are all done, or whose pause/cancel/failure has settled. */
  private settleJobs() {
    const db = this.ctx.db;
    const jobs = db.prepare("SELECT * FROM jobs WHERE status IN ('queued','running','pausing','cancelling','failed') AND finished_at IS NULL").all() as JobRow[];
    for (const job of jobs) {
      const stages = getStages(db, job.id);
      const anyRunning = stages.some((s) => s.status === "running") || stages.some((s) => this.running.has(s.id));
      const now = nowIso();
      const progress = computeJobProgress(stages);
      if (Math.abs(progress - job.progress) > 1e-6) db.prepare("UPDATE jobs SET progress = ? WHERE id = ?").run(progress, job.id);
      if (job.status === "pausing" && !anyRunning) {
        db.prepare("UPDATE jobs SET status = 'paused', current_stage = NULL, updated_at = ? WHERE id = ?").run(now, job.id);
        this.event(job.id, null, "info", "paused", "Job paused");
        this.publishJob(job.id, true);
      } else if (job.status === "cancelling" && !anyRunning) {
        this.finalizeCancel(job.id);
        this.publishJob(job.id, true);
      } else if (job.status === "failed" && !anyRunning) {
        db.prepare("UPDATE jobs SET finished_at = ?, current_stage = NULL, updated_at = ? WHERE id = ?").run(now, now, job.id);
        this.publishJob(job.id, true);
      } else if (["queued", "running"].includes(job.status) && stages.every((s) => ["completed", "skipped"].includes(s.status))) {
        db.prepare("UPDATE jobs SET status = 'completed', progress = 1, current_stage = NULL, finished_at = ?, updated_at = ? WHERE id = ?").run(now, now, job.id);
        this.event(job.id, null, "info", "completed", "Job completed");
        this.publishJob(job.id, true);
        this.ctx.events.publish("recording.updated", { id: job.recording_id });
      } else if (job.status === "running" && !anyRunning) {
        const next = stages.find((s) => s.status === "pending");
        if (next && job.current_stage !== null) db.prepare("UPDATE jobs SET current_stage = NULL WHERE id = ?").run(job.id);
      }
    }
  }

  private finalizeCancel(jobId: string) {
    const db = this.ctx.db;
    const now = nowIso();
    const job = getJob(db, jobId);
    db.prepare("UPDATE job_stages SET status = 'cancelled', updated_at = ? WHERE job_id = ? AND status IN ('pending','running','paused')").run(now, jobId);
    db.prepare("UPDATE jobs SET status = 'cancelled', current_stage = NULL, finished_at = ?, updated_at = ? WHERE id = ?").run(now, now, jobId);
    this.event(jobId, null, "info", "cancelled", job.keep_partial ? "Job cancelled (partial results kept)" : "Job cancelled");
    if (!job.keep_partial && job.type === "transcription") {
      removeWorkFiles(this.ctx.paths.recordings, job.recording_id).catch(() => undefined);
      db.prepare("DELETE FROM transcripts WHERE recording_id = ? AND status = 'partial'").run(job.recording_id);
    }
  }

  // ---- user actions -------------------------------------------------------

  pause(jobId: string) {
    const db = this.ctx.db;
    const job = getJob(db, jobId);
    assertTransition(job, ["queued", "running"], "pause");
    const anyRunning = [...this.running.values()].some((r) => r.stage.job_id === jobId);
    db.prepare("UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?").run(anyRunning ? "pausing" : "paused", nowIso(), jobId);
    for (const r of this.running.values()) if (r.stage.job_id === jobId) r.signal.request("pause");
    this.event(jobId, null, "info", "pause_requested", anyRunning ? "Pausing at the next safe boundary" : "Job paused");
    this.publishJob(jobId, true);
  }

  resume(jobId: string) {
    const db = this.ctx.db;
    const job = getJob(db, jobId);
    assertTransition(job, ["paused", "pausing"], "resume");
    if (job.status === "pausing") {
      // a stage may still be finishing its current segment; it will come back as pending
      for (const r of this.running.values()) if (r.stage.job_id === jobId) r.signal.reason = null;
    }
    db.prepare("UPDATE jobs SET status = 'queued', updated_at = ? WHERE id = ?").run(nowIso(), jobId);
    this.event(jobId, null, "info", "resumed", "Job resumed");
    this.publishJob(jobId, true);
    this.kick();
  }

  cancel(jobId: string, keepPartial = true) {
    const db = this.ctx.db;
    const job = getJob(db, jobId);
    assertTransition(job, ["queued", "running", "pausing", "paused"], "cancel");
    const anyRunning = [...this.running.values()].some((r) => r.stage.job_id === jobId);
    db.prepare("UPDATE jobs SET status = ?, keep_partial = ?, updated_at = ? WHERE id = ?").run(anyRunning ? "cancelling" : "cancelled", keepPartial ? 1 : 0, nowIso(), jobId);
    for (const r of this.running.values()) if (r.stage.job_id === jobId) r.signal.request("cancel");
    if (!anyRunning) this.finalizeCancel(jobId);
    this.publishJob(jobId, true);
  }

  retry(jobId: string) {
    const db = this.ctx.db;
    const job = getJob(db, jobId);
    assertTransition(job, ["failed", "cancelled"], "retry");
    const now = nowIso();
    // If partial results were discarded on cancel, earlier "completed" stages lost their outputs: redo them.
    const fromScratch = job.status === "cancelled" && !job.keep_partial;
    db.transaction(() => {
      db.prepare(
        `UPDATE job_stages SET status = 'pending', error = NULL, error_code = NULL, next_attempt_at = NULL, ended_at = NULL,
           progress = CASE WHEN ? THEN 0 ELSE progress END, progress_done = CASE WHEN ? THEN NULL ELSE progress_done END,
           max_retries = MAX(max_retries, retry_count + 2), updated_at = ?
         WHERE job_id = ? AND (status IN ('failed','cancelled') OR (? AND name != 'upload' AND status = 'completed'))`,
      ).run(fromScratch ? 1 : 0, fromScratch ? 1 : 0, now, jobId, fromScratch ? 1 : 0);
      db.prepare("UPDATE jobs SET status = 'queued', error = NULL, finished_at = NULL, updated_at = ? WHERE id = ?").run(now, jobId);
    })();
    this.event(jobId, null, "info", "retry", "Job requeued by user");
    this.publishJob(jobId, true);
    this.kick();
  }

  isRunning(jobId: string) {
    return [...this.running.values()].some((r) => r.stage.job_id === jobId);
  }

  runningSummary() {
    return [...this.running.values()].map((r) => ({ jobId: r.stage.job_id, stage: r.stage.name, lane: r.stage.lane }));
  }

  // ---- events --------------------------------------------------------------

  event(jobId: string, stage: string | null, level: "info" | "warn" | "error", type: string, message: string, data?: unknown) {
    this.ctx.db
      .prepare("INSERT INTO job_events (job_id, stage, level, type, message, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(jobId, stage, level, type, message, data === undefined ? null : JSON.stringify(data), nowIso());
    if (level !== "info") this.ctx.log[level === "error" ? "error" : "warn"]({ jobId, stage, type }, message);
  }

  /** Throttled SSE publication of a job snapshot (≤ 4/s per job unless forced). */
  publishJob(jobId: string, force = false) {
    const last = this.lastPublish.get(jobId) ?? 0;
    const send = () => {
      this.publishTimers.delete(jobId);
      this.lastPublish.set(jobId, Date.now());
      try {
        this.ctx.events.publish("job", jobSnapshot(this.ctx.db, jobId));
      } catch {
        this.ctx.events.publish("job.deleted", { id: jobId });
      }
    };
    if (force || Date.now() - last > 250) {
      clearTimeout(this.publishTimers.get(jobId));
      send();
    } else if (!this.publishTimers.has(jobId)) {
      this.publishTimers.set(jobId, setTimeout(send, 250));
    }
  }
}
