import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import type { Scheduler } from "../queue/scheduler.js";
import { UploadService, createUploadSchema } from "../uploads/service.js";
import { RecordingService } from "../recordings/service.js";
import { createJob, getJob, jobSnapshot, listJobs } from "../queue/jobs.js";
import { AppError, badRequest, notFound } from "../lib/util.js";
import { buildExportDoc, editSegment, loadTranscriptView } from "../transcript/store.js";
import { toJson, toMarkdown, toSrt, toTxt, toVtt } from "../transcript/exporters.js";
import { sanitizeFileStem } from "../obsidian/paths.js";

const uuidParam = z.object({ id: z.string().uuid() });

export function registerCoreRoutes(app: FastifyInstance, ctx: AppContext, scheduler: Scheduler, uploads: UploadService, recordings: RecordingService) {
  // ---- uploads ---------------------------------------------------------------
  app.post("/api/uploads", async (req) => uploads.create(req.user!.id, createUploadSchema.parse(req.body)));
  app.get("/api/uploads", async (req) => ({ items: uploads.listActive(req.user!.id) }));
  app.get("/api/uploads/:id", async (req) => uploads.get(req.user!.id, uuidParam.parse(req.params).id));
  app.put(
    "/api/uploads/:id/chunks/:index",
    { bodyLimit: 64 * 1024 * 1024 },
    async (req) => {
      const { id, index } = z.object({ id: z.string().uuid(), index: z.coerce.number().int().min(0) }).parse(req.params);
      const sha = String(req.headers["x-chunk-sha256"] ?? "").toLowerCase();
      return uploads.putChunk(req.user!.id, id, index, req.body as any, sha);
    },
  );
  app.post("/api/uploads/:id/complete", async (req) => {
    const { id } = uuidParam.parse(req.params);
    const r = await uploads.complete(req.user!.id, id);
    scheduler.kick();
    const job = ctx.db.prepare("SELECT id FROM jobs WHERE recording_id = ? ORDER BY created_at DESC LIMIT 1").get(r.recordingId) as any;
    if (job) scheduler.publishJob(job.id, true);
    ctx.events.publish("recording.updated", { id: r.recordingId });
    return { recordingId: r.recordingId, jobId: job?.id ?? null, created: r.created, sha256: r.session.sha256 };
  });
  app.delete("/api/uploads/:id", async (req) => uploads.cancel(req.user!.id, uuidParam.parse(req.params).id));

  // ---- recordings ------------------------------------------------------------
  app.get("/api/recordings", async (req) => {
    const q = z.object({ search: z.string().max(200).optional(), projectId: z.string().uuid().optional(), limit: z.coerce.number().optional(), offset: z.coerce.number().optional() }).parse(req.query);
    return recordings.list(q);
  });
  app.get("/api/recordings/:id", async (req) => recordings.describe(recordings.get(uuidParam.parse(req.params).id)));
  app.patch("/api/recordings/:id", async (req) => {
    const body = z
      .object({ title: z.string().max(200).optional(), projectId: z.string().uuid().nullable().optional(), recordedAt: z.string().datetime({ offset: true }).nullable().optional(), vocabulary: z.string().max(4000).optional(), languageHint: z.enum(["auto", "zh", "en"]).optional() })
      .parse(req.body);
    return recordings.update(uuidParam.parse(req.params).id, body);
  });
  app.delete("/api/recordings/:id", async (req) => {
    const body = z.object({ deleteObsidianFiles: z.boolean().default(false), confirm: z.string().optional() }).parse(req.body ?? {});
    if (body.deleteObsidianFiles && body.confirm !== "DELETE OBSIDIAN FILES") throw badRequest('Deleting Obsidian files requires confirm: "DELETE OBSIDIAN FILES"');
    return recordings.deleteRecording(uuidParam.parse(req.params).id, body);
  });
  app.delete("/api/recordings/:id/audio", async (req) => recordings.deleteAudio(uuidParam.parse(req.params).id));
  app.delete("/api/recordings/:id/transcript", async (req) => recordings.deleteTranscript(uuidParam.parse(req.params).id));

  app.get("/api/recordings/:id/audio", async (req, reply) => {
    const r = recordings.get(uuidParam.parse(req.params).id);
    const file = r.source_path && fs.existsSync(r.source_path) ? r.source_path : r.audio_path && fs.existsSync(r.audio_path) ? r.audio_path : null;
    if (!file) throw notFound("audio");
    // served from the recording directory only (never a client-supplied path)
    const ext = path.extname(file).slice(1).toLowerCase();
    const type = { mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", flac: "audio/flac", ogg: "audio/ogg", opus: "audio/ogg", mp4: "video/mp4" }[ext] ?? "application/octet-stream";
    return reply.header("Cache-Control", "private, max-age=3600").type(type).sendFile(path.basename(file), path.dirname(file));
  });
  app.get("/api/recordings/:id/peaks", async (req, reply) => {
    const r = recordings.get(uuidParam.parse(req.params).id);
    if (!r.peaks_path || !fs.existsSync(r.peaks_path)) throw notFound("waveform");
    return reply.type("application/json").header("Cache-Control", "private, max-age=3600").send(fs.createReadStream(r.peaks_path));
  });
  app.get("/api/recordings/:id/transcript", async (req) => {
    const { id } = uuidParam.parse(req.params);
    const { words } = z.object({ words: z.coerce.boolean().optional() }).parse(req.query);
    const v = loadTranscriptView(ctx.db, id, { words });
    if (!v) throw notFound("transcript");
    return v;
  });
  app.patch("/api/segments/:sid", async (req) => {
    const { sid } = z.object({ sid: z.coerce.number().int() }).parse(req.params);
    const body = z.object({ text: z.string().max(20000).optional(), recordingSpeakerId: z.string().uuid().nullable().optional() }).parse(req.body);
    editSegment(ctx.db, sid, body);
    const seg = ctx.db.prepare("SELECT t.recording_id FROM transcript_segments s JOIN transcripts t ON t.id = s.transcript_id WHERE s.id = ?").get(sid) as any;
    ctx.events.publish("transcript.updated", { recordingId: seg.recording_id });
    return { ok: true };
  });
  app.get("/api/segments/:sid/revisions", async (req) => {
    const { sid } = z.object({ sid: z.coerce.number().int() }).parse(req.params);
    return { items: ctx.db.prepare("SELECT field, old_value, new_value, created_at FROM segment_revisions WHERE segment_id = ? ORDER BY id DESC").all(sid) };
  });
  app.get("/api/recordings/:id/export", async (req, reply) => {
    const { id } = uuidParam.parse(req.params);
    const { format } = z.object({ format: z.enum(["txt", "md", "json", "srt", "vtt"]) }).parse(req.query);
    const doc = buildExportDoc(ctx.db, id);
    const body = { txt: toTxt, md: toMarkdown, json: toJson, srt: toSrt, vtt: toVtt }[format](doc);
    const mime = { txt: "text/plain", md: "text/markdown", json: "application/json", srt: "application/x-subrip", vtt: "text/vtt" }[format];
    const name = `${sanitizeFileStem(doc.title)}.${format}`;
    return reply
      .type(`${mime}; charset=utf-8`)
      .header("Content-Disposition", `attachment; filename="transcript.${format}"; filename*=UTF-8''${encodeURIComponent(name)}`)
      .send(body);
  });
  app.post("/api/recordings/:id/retranscribe", async (req) => {
    const { id } = uuidParam.parse(req.params);
    const r = recordings.get(id);
    if (!r.source_path) throw new AppError(409, "no_audio", "The original audio was deleted; cannot transcribe again");
    const body = z.object({ noteTemplate: z.enum(["none", "meeting", "class"]).default("none"), export: z.boolean().optional() }).parse(req.body ?? {});
    const jobId = createJob(ctx.db, ctx.settings.get(), { recordingId: id, type: "transcription", options: body });
    scheduler.kick();
    scheduler.publishJob(jobId, true);
    return { jobId };
  });
  app.get("/api/recordings/:id/notes", async (req) => ({ items: recordings.notes(uuidParam.parse(req.params).id) }));
  app.post("/api/recordings/:id/notes", async (req) => {
    const { id } = uuidParam.parse(req.params);
    recordings.get(id);
    const t = ctx.db.prepare("SELECT status FROM transcripts WHERE recording_id = ?").get(id) as any;
    if (t?.status !== "complete") throw new AppError(409, "no_transcript", "Transcript is not complete yet");
    const body = z
      .object({
        template: z.enum(["meeting", "class"]),
        provider: z.enum(["claude", "codex"]).optional(),
        model: z.string().max(100).optional(),
        effort: z.string().max(20).optional(),
        language: z.string().max(20).optional(),
        export: z.boolean().optional(),
      })
      .parse(req.body);
    ctx.llm.resolve(body); // validate early
    const jobId = createJob(ctx.db, ctx.settings.get(), {
      recordingId: id,
      type: "notes",
      options: { noteTemplate: body.template, provider: body.provider, model: body.model, effort: body.effort, noteLanguage: body.language, export: body.export, exportKinds: ["note"] },
    });
    scheduler.kick();
    scheduler.publishJob(jobId, true);
    return { jobId };
  });
  app.delete("/api/notes/:id", async (req) => {
    const body = z.object({ deleteObsidianFile: z.boolean().default(false), confirm: z.string().optional() }).parse(req.body ?? {});
    if (body.deleteObsidianFile && body.confirm !== "DELETE OBSIDIAN FILE") throw badRequest('Deleting the Obsidian file requires confirm: "DELETE OBSIDIAN FILE"');
    return recordings.deleteNote(uuidParam.parse(req.params).id, body);
  });

  // ---- jobs ------------------------------------------------------------------
  app.get("/api/jobs", async (req) => {
    const q = z.object({ status: z.string().max(200).optional(), recordingId: z.string().uuid().optional(), limit: z.coerce.number().optional() }).parse(req.query);
    return { items: listJobs(ctx.db, q) };
  });
  app.get("/api/jobs/:id", async (req) => {
    const { id } = uuidParam.parse(req.params);
    const snap = jobSnapshot(ctx.db, id);
    const events = ctx.db.prepare("SELECT id, stage, level, type, message, data, created_at FROM job_events WHERE job_id = ? ORDER BY id DESC LIMIT 200").all(id);
    return { ...snap, events };
  });
  for (const action of ["pause", "resume", "cancel", "retry"] as const) {
    app.post(`/api/jobs/:id/${action}`, async (req) => {
      const { id } = uuidParam.parse(req.params);
      getJob(ctx.db, id);
      if (action === "cancel") {
        const { keepPartial } = z.object({ keepPartial: z.boolean().default(true) }).parse(req.body ?? {});
        scheduler.cancel(id, keepPartial);
      } else scheduler[action](id);
      return jobSnapshot(ctx.db, id);
    });
  }
}
