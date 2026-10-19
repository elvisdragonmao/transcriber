import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { AppContext } from "../context.js";
import { AppError, conflict, dirSize, freeBytes, json, notFound, nowIso } from "../lib/util.js";
import { createJob, type JobOptions } from "../queue/jobs.js";
import type { UploadOptions, UploadSessionRow } from "../uploads/service.js";
import { cleanupIntermediates } from "../stages/model.js";

export function recordingFactory(ctx: AppContext) {
  return (args: { session: UploadSessionRow; options: UploadOptions; sourcePath: string; sha256: string; recordingId: string }) => {
    const { session, options } = args;
    const now = nowIso();
    const stem = session.filename.replace(/\.[^.]+$/, "").trim() || "Recording";
    const recordedAt = options.recordedAt ?? (session.last_modified ? new Date(session.last_modified).toISOString() : null);
    ctx.db
      .prepare(
        `INSERT INTO recordings (id, title, title_source, project_id, original_filename, mime_type, size_bytes, sha256, source_path, recorded_at,
           language_hint, vocabulary, note_template, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        args.recordingId,
        (options.title || stem).slice(0, 200),
        options.title ? "user" : "filename",
        options.projectId ?? null,
        session.filename,
        session.mime_type,
        session.size_bytes,
        args.sha256,
        args.sourcePath,
        recordedAt,
        options.language,
        options.vocabulary,
        options.noteTemplate,
        now,
        now,
      );
    const jobOpts: JobOptions = { noteTemplate: options.noteTemplate, export: options.autoExport };
    createJob(ctx.db, ctx.settings.get(), {
      recordingId: args.recordingId,
      type: "transcription",
      options: jobOpts,
      idempotencyKey: `upload:${session.id}`,
      uploadTimes: { start: session.created_at, end: now, bytes: session.size_bytes },
    });
  };
}

export class RecordingService {
  constructor(private ctx: AppContext) {}

  private get db() {
    return this.ctx.db;
  }

  get(id: string) {
    const r = this.db.prepare("SELECT * FROM recordings WHERE id = ?").get(id) as any;
    if (!r) throw notFound("recording");
    return r;
  }

  describe(r: any) {
    const project = r.project_id ? (this.db.prepare("SELECT id, name, vault_folder FROM projects WHERE id = ?").get(r.project_id) as any) : null;
    const t = this.db.prepare("SELECT status, language, revision FROM transcripts WHERE recording_id = ?").get(r.id) as any;
    const active = this.db
      .prepare("SELECT id, type, status, progress, current_stage FROM jobs WHERE recording_id = ? AND status IN ('queued','running','pausing','paused','cancelling') ORDER BY created_at DESC")
      .all(r.id);
    const last = this.db.prepare("SELECT id, type, status, error FROM jobs WHERE recording_id = ? ORDER BY created_at DESC LIMIT 1").get(r.id);
    const speakers = this.db.prepare("SELECT COUNT(*) AS n FROM recording_speakers WHERE recording_id = ?").get(r.id) as any;
    const notes = this.db.prepare("SELECT COUNT(*) AS n FROM generated_notes WHERE recording_id = ?").get(r.id) as any;
    return {
      id: r.id,
      title: r.title,
      titleSource: r.title_source,
      project,
      originalFilename: r.original_filename,
      sizeBytes: r.size_bytes,
      sha256: r.sha256,
      durationMs: r.duration_ms,
      codec: r.codec,
      sampleRate: r.sample_rate,
      channels: r.channels,
      recordedAt: r.recorded_at,
      languageHint: r.language_hint,
      vocabulary: r.vocabulary,
      noteTemplate: r.note_template,
      documentType: r.document_type,
      hasAudio: !!r.source_path && !r.audio_deleted_at,
      audioDeletedAt: r.audio_deleted_at,
      transcript: t ? { status: t.status, language: t.language, revision: t.revision } : null,
      speakerCount: speakers.n,
      noteCount: notes.n,
      activeJobs: active,
      lastJob: last ?? null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  list(q: { search?: string; projectId?: string; limit?: number; offset?: number }) {
    const where: string[] = [];
    const args: unknown[] = [];
    if (q.search) {
      where.push("(r.title LIKE ? OR r.original_filename LIKE ? OR EXISTS (SELECT 1 FROM transcripts t JOIN transcript_segments s ON s.transcript_id = t.id WHERE t.recording_id = r.id AND s.text LIKE ?))");
      const like = `%${q.search.replace(/[%_]/g, (m) => "\\" + m)}%`;
      args.push(like, like, like);
    }
    if (q.projectId) {
      where.push("r.project_id = ?");
      args.push(q.projectId);
    }
    const rows = this.db
      .prepare(`SELECT r.* FROM recordings r ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY r.created_at DESC LIMIT ? OFFSET ?`)
      .all(...args, Math.min(q.limit ?? 50, 200), q.offset ?? 0) as any[];
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM recordings r ${where.length ? "WHERE " + where.join(" AND ") : ""}`).get(...args) as any).n;
    return { total, items: rows.map((r) => this.describe(r)) };
  }

  update(id: string, patch: { title?: string; projectId?: string | null; recordedAt?: string | null; vocabulary?: string; languageHint?: string }) {
    const r = this.get(id);
    const now = nowIso();
    if (patch.title !== undefined) this.db.prepare("UPDATE recordings SET title = ?, title_source = 'user', updated_at = ? WHERE id = ?").run(patch.title.trim().slice(0, 200) || r.title, now, id);
    if (patch.projectId !== undefined) {
      if (patch.projectId && !this.db.prepare("SELECT 1 FROM projects WHERE id = ?").get(patch.projectId)) throw notFound("project");
      this.db.prepare("UPDATE recordings SET project_id = ?, updated_at = ? WHERE id = ?").run(patch.projectId, now, id);
    }
    if (patch.recordedAt !== undefined) this.db.prepare("UPDATE recordings SET recorded_at = ?, updated_at = ? WHERE id = ?").run(patch.recordedAt, now, id);
    if (patch.vocabulary !== undefined) this.db.prepare("UPDATE recordings SET vocabulary = ?, updated_at = ? WHERE id = ?").run(patch.vocabulary.slice(0, 4000), now, id);
    if (patch.languageHint !== undefined) {
      if (!["auto", "zh", "en"].includes(patch.languageHint)) throw new AppError(400, "bad_request", "languageHint must be auto, zh or en");
      this.db.prepare("UPDATE recordings SET language_hint = ?, updated_at = ? WHERE id = ?").run(patch.languageHint, now, id);
    }
    this.ctx.events.publish("recording.updated", { id });
    return this.describe(this.get(id));
  }

  private assertIdle(id: string) {
    const active = this.db.prepare("SELECT id FROM jobs WHERE recording_id = ? AND status IN ('queued','running','pausing','paused','cancelling')").get(id);
    if (active) throw conflict("Cancel or finish the active job for this recording first");
  }

  /** Delete the audio (original + derived), keep transcript, notes and speakers. */
  async deleteAudio(id: string) {
    const r = this.get(id);
    this.assertIdle(id);
    const dir = path.join(this.ctx.paths.recordings, id);
    let freed = 0;
    for (const f of [r.source_path, r.audio_path, r.peaks_path].filter(Boolean)) {
      try {
        freed += (await fsp.stat(f)).size;
        await fsp.rm(f, { force: true });
      } catch {
        /* already gone */
      }
    }
    freed += await cleanupIntermediates(this.ctx.paths.recordings, id);
    this.db.prepare("UPDATE recordings SET source_path = NULL, audio_path = NULL, peaks_path = NULL, audio_deleted_at = ?, updated_at = ? WHERE id = ?").run(nowIso(), nowIso(), id);
    this.ctx.events.publish("recording.updated", { id });
    return { ok: true, freedBytes: freed, dir };
  }

  /** Delete transcript + processing records (jobs, stages, speakers of this recording); audio and notes stay. */
  async deleteTranscript(id: string) {
    this.get(id);
    this.assertIdle(id);
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM transcripts WHERE recording_id = ?").run(id);
      this.db.prepare("DELETE FROM diarization_turns WHERE recording_id = ?").run(id);
      this.db.prepare("DELETE FROM recording_speakers WHERE recording_id = ?").run(id);
      this.db.prepare("DELETE FROM jobs WHERE recording_id = ? AND type = 'transcription'").run(id);
    })();
    await cleanupIntermediates(this.ctx.paths.recordings, id);
    await fsp.rm(path.join(this.ctx.paths.recordings, id, "transcript.json"), { force: true });
    this.ctx.events.publish("recording.updated", { id });
    return { ok: true };
  }

  /** Remove everything this system holds for the recording. Obsidian files only when explicitly requested. */
  async deleteRecording(id: string, opts: { deleteObsidianFiles?: boolean } = {}) {
    this.get(id);
    this.assertIdle(id);
    const removed: string[] = [];
    if (opts.deleteObsidianFiles) {
      const exports = this.db.prepare("SELECT id FROM obsidian_exports WHERE recording_id = ? AND status IN ('written','pending_review')").all(id) as any[];
      for (const e of exports) removed.push((await this.ctx.obsidian.deleteExportedFile(e.id)).path);
    }
    this.db.prepare("DELETE FROM recordings WHERE id = ?").run(id);
    await fsp.rm(path.join(this.ctx.paths.recordings, id), { recursive: true, force: true });
    this.ctx.events.publish("recording.deleted", { id });
    return { ok: true, obsidianFilesDeleted: removed };
  }

  async deleteNote(noteId: string, opts: { deleteObsidianFile?: boolean } = {}) {
    const n = this.db.prepare("SELECT * FROM generated_notes WHERE id = ?").get(noteId) as any;
    if (!n) throw notFound("note");
    const removed: string[] = [];
    if (opts.deleteObsidianFile) {
      const exports = this.db.prepare("SELECT id FROM obsidian_exports WHERE note_id = ? AND status IN ('written','pending_review')").all(noteId) as any[];
      for (const e of exports) removed.push((await this.ctx.obsidian.deleteExportedFile(e.id)).path);
    }
    this.db.prepare("DELETE FROM generated_notes WHERE id = ?").run(noteId);
    this.ctx.events.publish("recording.updated", { id: n.recording_id });
    return { ok: true, obsidianFilesDeleted: removed };
  }

  notes(recordingId: string) {
    return (
      this.db
        .prepare(
          `SELECT n.*, g.provider, g.model, g.effort, g.cost_usd, g.duration_ms FROM generated_notes n LEFT JOIN note_generations g ON g.id = n.generation_id
           WHERE n.recording_id = ? ORDER BY n.created_at DESC`,
        )
        .all(recordingId) as any[]
    ).map((n) => ({
      id: n.id,
      template: n.template,
      title: n.title,
      markdown: n.markdown,
      classification: json(n.classification, null),
      provider: n.provider,
      model: n.model,
      effort: n.effort,
      costUsd: n.cost_usd,
      durationMs: n.duration_ms,
      createdAt: n.created_at,
    }));
  }

  async storage() {
    const p = this.ctx.paths;
    const recs = this.db.prepare("SELECT id, source_path, audio_path FROM recordings").all() as any[];
    let source = 0;
    let derived = 0;
    let work = 0;
    for (const r of recs) {
      if (r.source_path) source += (await fsp.stat(r.source_path).catch(() => ({ size: 0 }))).size;
      if (r.audio_path) derived += (await fsp.stat(r.audio_path).catch(() => ({ size: 0 }))).size;
      work += await dirSize(path.join(p.recordings, r.id, "work"));
    }
    const dbSize = ["", "-wal", "-shm"].reduce((a, s) => a + (fs.existsSync(p.db + s) ? fs.statSync(p.db + s).size : 0), 0);
    return {
      sourceAudioBytes: source,
      derivedAudioBytes: derived,
      intermediateBytes: work,
      uploadChunkBytes: await dirSize(p.uploads),
      databaseBytes: dbSize,
      freeBytes: await freeBytes(this.ctx.config.dataDir),
      dataDir: this.ctx.config.dataDir,
      recordings: recs.length,
    };
  }

  /** Remove intermediate model outputs of finished recordings older than N days (transcripts are in SQLite). */
  async cleanupIntermediates(olderThanDays: number) {
    const cutoff = new Date(Date.now() - olderThanDays * 86400_000).toISOString();
    const rows = this.db
      .prepare(
        `SELECT r.id FROM recordings r JOIN transcripts t ON t.recording_id = r.id
         WHERE t.status = 'complete' AND t.updated_at < ? AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.recording_id = r.id AND j.status IN ('queued','running','pausing','paused','cancelling'))`,
      )
      .all(cutoff) as any[];
    let freed = 0;
    for (const r of rows) freed += await cleanupIntermediates(this.ctx.paths.recordings, r.id);
    return { recordings: rows.length, freedBytes: freed };
  }
}
