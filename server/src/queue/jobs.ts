import path from "node:path";
import fsp from "node:fs/promises";
import type { DB } from "../db/index.js";
import type { Settings } from "../settings.js";
import { AppError, conflict, json, notFound, nowIso, uuid } from "../lib/util.js";

export type JobType = "transcription" | "notes" | "export";
export type JobStatus = "queued" | "running" | "pausing" | "paused" | "cancelling" | "cancelled" | "completed" | "failed";
export type StageStatus = "pending" | "running" | "paused" | "completed" | "failed" | "skipped" | "cancelled";

export interface StageDef {
  name: string;
  lane: string;
  deps: string[];
  maxRetries?: number;
}

export const STAGE_LABELS: Record<string, string> = {
  upload: "Uploading",
  prepare: "Validating / Preparing Audio",
  vad: "VAD",
  asr: "ASR",
  align: "Forced Alignment",
  diarize: "Speaker Diarization",
  identify: "Speaker Identification",
  merge: "Merging Results",
  save: "Saving Transcript",
  notes: "AI Note Generation",
  export: "Obsidian Export",
};

export const PIPELINES: Record<JobType, StageDef[]> = {
  transcription: [
    { name: "upload", lane: "none", deps: [] },
    { name: "prepare", lane: "ffmpeg", deps: ["upload"] },
    { name: "vad", lane: "cpu", deps: ["prepare"] },
    { name: "asr", lane: "gpu-asr", deps: ["vad"], maxRetries: 3 },
    { name: "align", lane: "gpu-asr", deps: ["asr"], maxRetries: 3 },
    { name: "diarize", lane: "gpu-diar", deps: ["prepare"], maxRetries: 3 },
    { name: "identify", lane: "cpu", deps: ["diarize"] },
    { name: "merge", lane: "node", deps: ["align", "identify"] },
    { name: "save", lane: "node", deps: ["merge"] },
    { name: "notes", lane: "llm", deps: ["save"], maxRetries: 1 },
    { name: "export", lane: "node", deps: ["save", "notes"] },
  ],
  notes: [
    { name: "notes", lane: "llm", deps: [], maxRetries: 1 },
    { name: "export", lane: "node", deps: ["notes"] },
  ],
  export: [{ name: "export", lane: "node", deps: [] }],
};

export interface JobOptions {
  noteTemplate?: "none" | "meeting" | "class";
  export?: boolean;
  provider?: "claude" | "codex";
  model?: string;
  effort?: string;
  noteLanguage?: string;
  /** export job: which artefacts */
  exportKinds?: ("transcript" | "note")[];
  noteId?: string;
  overwrite?: boolean;
}

export interface JobRow {
  id: string;
  recording_id: string;
  type: JobType;
  status: JobStatus;
  options: string;
  progress: number;
  current_stage: string | null;
  error: string | null;
  keep_partial: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface StageRow {
  id: string;
  job_id: string;
  name: string;
  seq: number;
  lane: string;
  depends_on: string;
  weight: number;
  status: StageStatus;
  progress: number | null;
  progress_done: number | null;
  progress_total: number | null;
  progress_unit: string | null;
  progress_detail: string | null;
  rate_started_at: string | null;
  rate_base_done: number | null;
  started_at: string | null;
  ended_at: string | null;
  error: string | null;
  error_code: string | null;
  retry_count: number;
  max_retries: number;
  next_attempt_at: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  checkpoint_path: string | null;
  output_path: string | null;
  model_version: string | null;
  updated_at: string;
}

export function workDir(recordingsDir: string, recordingId: string) {
  return path.join(recordingsDir, recordingId, "work");
}

export function createJob(
  db: DB,
  settings: Settings,
  args: { recordingId: string; type: JobType; options: JobOptions; idempotencyKey?: string; uploadTimes?: { start: string; end: string; bytes: number } },
): string {
  if (args.idempotencyKey) {
    const existing = db.prepare("SELECT id FROM jobs WHERE idempotency_key = ?").get(args.idempotencyKey) as { id: string } | undefined;
    if (existing) return existing.id;
  }
  const busy = db
    .prepare("SELECT id, type FROM jobs WHERE recording_id = ? AND status IN ('queued','running','pausing','paused','cancelling')")
    .all(args.recordingId) as { id: string; type: string }[];
  if (args.type === "transcription" && busy.some((b) => b.type === "transcription"))
    throw conflict("This recording already has an active transcription job");
  if (args.type !== "transcription" && busy.some((b) => b.type === "transcription"))
    throw conflict("Wait for the transcription job to finish first");
  if (args.type === "notes" && busy.some((b) => b.type === "notes")) throw conflict("A note generation job is already running for this recording");

  const id = uuid();
  const now = nowIso();
  const w = settings.queue.weights;
  const noteTemplate = args.options.noteTemplate ?? "none";
  const obsidianOn = settings.obsidian.backend !== "none";
  const wantExport = args.options.export ?? (settings.obsidian.autoExport && obsidianOn);
  db.transaction(() => {
    db.prepare(
      "INSERT INTO jobs (id, recording_id, type, status, options, progress, created_at, updated_at, idempotency_key) VALUES (?, ?, ?, 'queued', ?, 0, ?, ?, ?)",
    ).run(id, args.recordingId, args.type, JSON.stringify(args.options), now, now, args.idempotencyKey ?? null);
    const ins = db.prepare(
      `INSERT INTO job_stages (id, job_id, name, seq, lane, depends_on, weight, status, progress, progress_done, progress_total, progress_unit, started_at, ended_at, max_retries, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    PIPELINES[args.type].forEach((st, i) => {
      let status: StageStatus = "pending";
      let progress: number | null = 0;
      let done: number | null = null;
      let total: number | null = null;
      let unit: string | null = null;
      let started: string | null = null;
      let ended: string | null = null;
      if (st.name === "upload") {
        status = "completed";
        progress = 1;
        done = total = args.uploadTimes?.bytes ?? null;
        unit = "bytes";
        started = args.uploadTimes?.start ?? now;
        ended = args.uploadTimes?.end ?? now;
      }
      if (st.name === "notes" && noteTemplate === "none") status = "skipped";
      if (st.name === "export" && !wantExport) status = "skipped";
      if (st.name === "diarize" && settings.gpu.diarDevice === "cpu") st = { ...st, lane: "cpu" };
      ins.run(uuid(), id, st.name, i, st.lane, JSON.stringify(st.deps), w[st.name] ?? 1, status, progress, done, total, unit, started, ended, st.maxRetries ?? 2, now);
    });
    db.prepare("INSERT INTO job_events (job_id, stage, level, type, message, created_at) VALUES (?, NULL, 'info', 'created', ?, ?)").run(
      id,
      `${args.type} job queued`,
      now,
    );
  })();
  return id;
}

export function getJob(db: DB, id: string): JobRow {
  const j = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
  if (!j) throw notFound("job");
  return j;
}

export function getStages(db: DB, jobId: string): StageRow[] {
  return db.prepare("SELECT * FROM job_stages WHERE job_id = ? ORDER BY seq").all(jobId) as StageRow[];
}

export function stageEta(s: StageRow): number | null {
  if (s.status !== "running" || s.progress_done == null || !s.progress_total || !s.rate_started_at) return null;
  const elapsed = (Date.now() - Date.parse(s.rate_started_at)) / 1000;
  const gained = s.progress_done - (s.rate_base_done ?? 0);
  if (elapsed < 8 || gained <= 0) return null;
  const rate = gained / elapsed;
  return Math.max(0, (s.progress_total - s.progress_done) / rate);
}

export function computeJobProgress(stages: StageRow[]): number {
  let num = 0;
  let den = 0;
  for (const s of stages) {
    if (s.status === "skipped") continue;
    den += s.weight;
    if (s.status === "completed") num += s.weight;
    else if (s.progress != null) num += s.weight * Math.max(0, Math.min(1, s.progress));
  }
  return den ? num / den : 0;
}

/** Historical seconds-of-processing per second-of-audio for a stage (median of recent runs). */
export function historicalRtf(db: DB, stage: string): number | null {
  const rows = db
    .prepare(
      `SELECT (julianday(s.ended_at) - julianday(s.started_at)) * 86400.0 AS secs, r.duration_ms AS dur
       FROM job_stages s JOIN jobs j ON j.id = s.job_id JOIN recordings r ON r.id = j.recording_id
       WHERE s.name = ? AND s.status = 'completed' AND s.started_at IS NOT NULL AND s.ended_at IS NOT NULL AND r.duration_ms > 60000 AND s.retry_count = 0
       ORDER BY s.ended_at DESC LIMIT 15`,
    )
    .all(stage) as { secs: number; dur: number }[];
  if (rows.length < 1) return null;
  const v = rows.map((r) => r.secs / (r.dur / 1000)).sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)];
}

const HEAVY = new Set(["asr", "align", "diarize", "identify", "vad", "prepare"]);

/** Job-level ETA along the critical path; null unless every heavy remaining stage has data. */
export function jobEta(db: DB, job: JobRow, stages: StageRow[], durationMs: number | null): number | null {
  if (!["running", "queued"].includes(job.status) || !durationMs) return null;
  const byName = new Map(stages.map((s) => [s.name, s]));
  const cost = (name: string): number | null => {
    const s = byName.get(name);
    if (!s || s.status === "completed" || s.status === "skipped") return 0;
    if (s.status === "running") {
      const e = stageEta(s);
      if (e != null) return e;
    }
    if (!HEAVY.has(name)) return name === "notes" ? null : 1;
    const rtf = historicalRtf(db, name);
    if (rtf == null) return null;
    const total = rtf * (durationMs / 1000);
    return s.status === "running" && s.progress != null ? total * (1 - s.progress) : total;
  };
  const memo = new Map<string, number | null>();
  const finish = (name: string): number | null => {
    if (memo.has(name)) return memo.get(name)!;
    const s = byName.get(name);
    if (!s) return 0;
    const deps = json<string[]>(s.depends_on, []);
    let start = 0;
    for (const d of deps) {
      const f = finish(d);
      if (f == null) return memo.set(name, null).get(name)!;
      start = Math.max(start, f);
    }
    const c = cost(name);
    const r = c == null ? null : start + c;
    memo.set(name, r);
    return r;
  };
  let eta = 0;
  for (const s of stages) {
    if (s.status === "skipped") continue;
    const f = finish(s.name);
    if (f == null) return null;
    eta = Math.max(eta, f);
  }
  return Math.round(eta);
}

export function jobSnapshot(db: DB, jobOrId: string | JobRow) {
  const job = typeof jobOrId === "string" ? getJob(db, jobOrId) : jobOrId;
  const stages = getStages(db, job.id);
  const rec = db.prepare("SELECT id, title, duration_ms, original_filename FROM recordings WHERE id = ?").get(job.recording_id) as any;
  return {
    id: job.id,
    recordingId: job.recording_id,
    recordingTitle: rec?.title ?? null,
    durationMs: rec?.duration_ms ?? null,
    type: job.type,
    status: job.status,
    progress: job.progress,
    currentStage: job.current_stage,
    error: job.error,
    options: json(job.options, {}),
    createdAt: job.created_at,
    updatedAt: job.updated_at,
    startedAt: job.started_at,
    finishedAt: job.finished_at,
    etaSeconds: jobEta(db, job, stages, rec?.duration_ms ?? null),
    stages: stages.map((s) => ({
      name: s.name,
      label: STAGE_LABELS[s.name] ?? s.name,
      lane: s.lane,
      status: s.status,
      progress: s.progress,
      done: s.progress_done,
      total: s.progress_total,
      unit: s.progress_unit,
      detail: json(s.progress_detail, null),
      startedAt: s.started_at,
      endedAt: s.ended_at,
      error: s.error,
      errorCode: s.error_code,
      retryCount: s.retry_count,
      maxRetries: s.max_retries,
      nextAttemptAt: s.next_attempt_at,
      etaSeconds: stageEta(s),
      modelVersion: s.model_version,
    })),
  };
}

export function listJobs(db: DB, filter: { status?: string; recordingId?: string; limit?: number }) {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.status) {
    where.push(`status IN (${filter.status.split(",").map(() => "?").join(",")})`);
    args.push(...filter.status.split(","));
  }
  if (filter.recordingId) {
    where.push("recording_id = ?");
    args.push(filter.recordingId);
  }
  const rows = db
    .prepare(`SELECT * FROM jobs ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT ?`)
    .all(...args, Math.min(filter.limit ?? 100, 500)) as JobRow[];
  return rows.map((j) => jobSnapshot(db, j));
}

export async function removeWorkFiles(recordingsDir: string, recordingId: string) {
  await fsp.rm(workDir(recordingsDir, recordingId), { recursive: true, force: true });
}

export function assertTransition(job: JobRow, allowed: JobStatus[], action: string) {
  if (!allowed.includes(job.status)) throw new AppError(409, "invalid_state", `Cannot ${action} a job that is ${job.status}`);
}
