import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { FatalStageError } from "../lib/errors.js";
import { workDir } from "../queue/jobs.js";
import { WorkerCallError, type Lane } from "../workers/pool.js";
import { asrAudioPath, audioPaths } from "./prepare.js";
import { cleanSpans, mergeTranscript, speechMsBySpeaker, type AlignSeg, type AsrSeg, type Turn } from "../transcript/merge.js";
import { toBlob } from "../transcript/voiceprint.js";
import { applySpeakerMatching } from "../speakers/match.js";
import { markTranscriptComplete, saveMergedTranscript, SPEAKER_COLORS, buildExportDoc } from "../transcript/store.js";
import { toJson } from "../transcript/exporters.js";
import { nowIso, readJson, uuid, writeFileAtomic } from "../lib/util.js";
import type { StageContext, StageHandler, StageOutcome } from "./types.js";

function recording(ctx: StageContext) {
  const r = ctx.app.db.prepare("SELECT * FROM recordings WHERE id = ?").get(ctx.job.recording_id) as any;
  if (!r?.audio_path || !fs.existsSync(r.audio_path)) throw new FatalStageError("BAD_INPUT", "Prepared audio is missing; retry the job from the start");
  return r;
}

const files = (ctx: StageContext) => {
  const d = workDir(ctx.app.paths.recordings, ctx.job.recording_id);
  return {
    dir: d,
    vad: path.join(d, "vad.json"),
    asr: path.join(d, "asr.json"),
    asrCk: path.join(d, "asr.ckpt.json"),
    align: path.join(d, "align.json"),
    alignCk: path.join(d, "align.ckpt.json"),
    diar: path.join(d, "diar.json"),
    identify: path.join(d, "identify.json"),
  };
};

async function callWorker(ctx: StageContext, lane: Lane, op: string, params: Record<string, unknown>, timeoutMs?: number): Promise<any> {
  const res = await ctx.app.workers.call(lane, op, params, {
    signal: ctx.signal,
    timeoutMs,
    onProgress: (p) => ctx.progress(p.done, p.total, p.unit, p.detail),
    onLog: (level, msg) => ctx.log(level === "warn" ? "warn" : "info", msg),
  });
  return res;
}

const paused = (r: any): r is { status: "paused" } => r?.status === "paused";

export const vad: StageHandler = async (ctx) => {
  const rec = recording(ctx);
  const f = files(ctx);
  const s = ctx.app.settings.get();
  const r = await callWorker(ctx, "cpu", "vad", {
    audio_path: asrAudioPath(ctx.app.paths.recordings, rec.id),
    output_path: f.vad,
    threshold: s.vad.threshold,
    min_speech_ms: s.vad.minSpeechMs,
    min_silence_ms: s.vad.minSilenceMs,
    speech_pad_ms: s.vad.speechPadMs,
    max_segment_s: s.asr.maxSegmentSec,
    min_segment_s: s.asr.minSegmentSec,
    max_gap_s: s.asr.maxMergeGapSec,
  });
  if (paused(r)) return { kind: "paused" };
  return {
    kind: "completed",
    outputPath: f.vad,
    modelVersion: r.model_version,
    detail: { segments: r.segments, speechMs: r.speech_ms, totalMs: r.total_ms },
    message: `VAD found ${Math.round(r.speech_ms / 1000)} s of speech in ${r.segments} ASR segments`,
  };
};

export const asr: StageHandler = async (ctx) => {
  const rec = recording(ctx);
  const f = files(ctx);
  const s = ctx.app.settings.get();
  const r = await callWorker(ctx, "gpu-asr", "asr", {
    audio_path: asrAudioPath(ctx.app.paths.recordings, rec.id),
    segments_path: f.vad,
    output_path: f.asr,
    checkpoint_path: f.asrCk,
    model: s.asr.model,
    language: rec.language_hint,
    vocabulary: rec.vocabulary,
    chinese_script: s.asr.chineseScript,
    context_chars: s.asr.contextChars,
    max_new_tokens: s.asr.maxNewTokens,
  });
  if (paused(r)) return { kind: "paused" };
  if (r.resumed_segments) ctx.log("info", `Resumed: ${r.resumed_segments} segments came from the checkpoint`);
  return { kind: "completed", outputPath: f.asr, modelVersion: r.model_version, detail: { segments: r.segments, languagesMs: r.languages_ms, resumed: r.resumed_segments } };
};

export const align: StageHandler = async (ctx) => {
  const rec = recording(ctx);
  const f = files(ctx);
  const r = await callWorker(ctx, "gpu-asr", "align", {
    audio_path: asrAudioPath(ctx.app.paths.recordings, rec.id),
    asr_path: f.asr,
    output_path: f.align,
    checkpoint_path: f.alignCk,
    model: ctx.app.settings.get().asr.alignerModel,
  });
  if (paused(r)) return { kind: "paused" };
  if (r.unaligned_segments) ctx.log("warn", `${r.unaligned_segments} segment(s) in unsupported languages got estimated word times`);
  return { kind: "completed", outputPath: f.align, modelVersion: r.model_version, detail: { words: r.words, unaligned: r.unaligned_segments } };
};

export const diarize: StageHandler = async (ctx) => {
  const rec = recording(ctx);
  const f = files(ctx);
  const s = ctx.app.settings.get();
  const onCpu = ctx.stage.lane === "cpu";
  const params = {
    audio_path: audioPaths(ctx.app.paths.recordings, rec.id).raw,
    output_path: f.diar,
    model: s.diar.model,
    device: onCpu ? "cpu" : "cuda",
    chunk_len: s.diar.chunkLen,
    right_context: s.diar.rightContext,
    max_speakers: s.diar.maxSpeakers,
  };
  let r: any;
  try {
    r = await callWorker(ctx, onCpu ? "cpu" : "gpu-diar", "diarize", params);
  } catch (e) {
    const gpuProblem = e instanceof WorkerCallError && ["OOM", "DEVICE_UNSUPPORTED", "WORKER_START_FAILED"].includes(e.code);
    if (!onCpu && gpuProblem && s.gpu.diarFallback === "cpu" && (ctx.stage.retry_count >= 1 || e.code === "DEVICE_UNSUPPORTED")) {
      ctx.log("warn", `Diarization GPU failed (${e.code}): ${e.message}. Falling back to CPU — this is several times slower.`);
      ctx.setLane("cpu");
      r = await callWorker(ctx, "cpu", "diarize", { ...params, device: "cpu" });
    } else throw e;
  }
  if (paused(r)) return { kind: "paused" };
  return {
    kind: "completed",
    outputPath: f.diar,
    modelVersion: r.model_version,
    detail: { speakers: r.speakers, turns: r.turns, device: r.device, rtfx: r.rtfx },
    message: `Diarization found ${r.speakers} speaker(s) on ${r.device} (${r.rtfx}× real time)`,
  };
};

export const identify: StageHandler = async (ctx) => {
  const rec = recording(ctx);
  const f = files(ctx);
  const s = ctx.app.settings.get();
  const db = ctx.app.db;
  const diar = await readJson<{ turns: Turn[]; speakers: number[] }>(f.diar);
  if (!diar) throw new FatalStageError("BAD_STATE", "diarization output missing");
  const clean = cleanSpans(diar.turns, s.identify.minCleanSegmentSec * 1000, s.identify.maxCleanSpeechSec * 1000);
  const speech = speechMsBySpeaker(diar.turns);

  let emb: Record<string, { embedding: number[] | null; used_ms: number; consistency: number | null }> = {};
  let modelVersion: string | undefined;
  const spans: Record<string, number[][]> = {};
  for (const [k, v] of clean) if (v.length) spans[String(k)] = v;
  if (s.identify.enabled && Object.keys(spans).length) {
    const r = await callWorker(ctx, "cpu", "embed", { audio_path: audioPaths(ctx.app.paths.recordings, rec.id).raw, speakers: spans, output_path: f.identify, model: s.identify.model });
    if (paused(r)) return { kind: "paused" };
    modelVersion = r.model_version;
    emb = ((await readJson<any>(f.identify))?.speakers ?? {}) as typeof emb;
  } else {
    ctx.progress(1, 1, "spans");
  }

  const locals = diar.speakers.map((k) => ({
    key: k,
    embedding: emb[String(k)]?.embedding ? Float32Array.from(emb[String(k)].embedding!) : null,
    cleanMs: emb[String(k)]?.used_ms ?? 0,
  }));

  db.transaction(() => {
    // Re-running replaces automatic results but keeps manual naming made on the same diarization index.
    const prev = new Map(
      (db.prepare("SELECT diar_index, speaker_id, assignment, label FROM recording_speakers WHERE recording_id = ?").all(rec.id) as any[]).map((r) => [r.diar_index, r]),
    );
    db.prepare("DELETE FROM recording_speakers WHERE recording_id = ?").run(rec.id);
    const ins = db.prepare(
      `INSERT INTO recording_speakers (id, recording_id, diar_index, label, speaker_id, assignment, speech_ms, clean_speech_ms, embedding, embedding_model, color)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const l of locals) {
      const p = prev.get(l.key);
      const manual = p?.assignment === "manual" && p.speaker_id;
      ins.run(
        uuid(),
        rec.id,
        l.key,
        p?.label ?? `Speaker ${l.key + 1}`,
        manual ? p.speaker_id : null,
        manual ? "manual" : "unknown",
        speech.get(l.key) ?? 0,
        l.cleanMs,
        l.embedding ? toBlob(l.embedding) : null,
        l.embedding ? s.identify.model : null, // the model id, so later matching compares like with like
        l.key % SPEAKER_COLORS,
      );
    }
  })();
  // Preliminary match with the user's language hint; `merge` re-applies it with the detected language.
  const hint = rec.language_hint === "zh" ? "Chinese" : rec.language_hint === "en" ? "English" : null;
  const { threshold, matches } = applySpeakerMatching(db, rec.id, hint, s.identify);
  const auto = matches.filter((m) => m.assignment === "auto").length;
  return {
    kind: "completed",
    outputPath: f.identify,
    modelVersion,
    detail: { speakers: locals.length, autoNamed: auto, suggested: matches.filter((m) => m.assignment === "suggested").length, threshold },
    message: `Voiceprints for ${locals.filter((l) => l.embedding).length} of ${locals.length} speaker(s); preliminary match: ${auto} known (threshold ${threshold})`,
  };
};

export const merge: StageHandler = async (ctx) => {
  const f = files(ctx);
  const [asrOut, alignOut, diarOut] = await Promise.all([readJson<any>(f.asr), readJson<any>(f.align), readJson<any>(f.diar)]);
  if (!asrOut || !alignOut || !diarOut) throw new FatalStageError("BAD_STATE", "Intermediate results missing; retry from the start");
  ctx.progress(0, 1, "steps");
  const asrSegs: AsrSeg[] = asrOut.segments;
  const { words, segments } = mergeTranscript(asrSegs, alignOut.segments as AlignSeg[], diarOut.turns as Turn[]);
  const stages = ctx.app.db.prepare("SELECT name, model_version FROM job_stages WHERE job_id = ?").all(ctx.job.id) as any[];
  saveMergedTranscript(ctx.app.db, {
    recordingId: ctx.job.recording_id,
    jobId: ctx.job.id,
    asr: asrSegs,
    turns: diarOut.turns,
    segments,
    words,
    modelInfo: Object.fromEntries(stages.filter((s) => s.model_version).map((s) => [s.name, s.model_version])),
    languagesMs: asrOut.languages_ms ?? {},
  });
  // Now the dominant language is known: decide voiceprint matches with its threshold.
  const lang = Object.entries((asrOut.languages_ms ?? {}) as Record<string, number>).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const m = applySpeakerMatching(ctx.app.db, ctx.job.recording_id, lang, ctx.app.settings.get().identify);
  ctx.log("info", `Speaker matching with ${lang ?? "unknown"} threshold ${m.threshold}: ${m.matches.filter((x) => x.assignment === "auto").length} auto, ${m.matches.filter((x) => x.assignment === "suggested").length} suggested`);
  ctx.progress(1, 1, "steps");
  const counts = { assigned: 0, overlap: 0, uncertain: 0 } as Record<string, number>;
  for (const s of segments) counts[s.status]++;
  return { kind: "completed", detail: { segments: segments.length, words: words.length, ...counts }, message: `Merged ${segments.length} segments (${counts.overlap} overlap, ${counts.uncertain} uncertain)` };
};

export const save: StageHandler = async (ctx) => {
  markTranscriptComplete(ctx.app.db, ctx.job.recording_id);
  const doc = buildExportDoc(ctx.app.db, ctx.job.recording_id);
  const out = path.join(ctx.app.paths.recordings, ctx.job.recording_id, "transcript.json");
  await writeFileAtomic(out, toJson(doc));
  ctx.app.db.prepare("UPDATE recordings SET updated_at = ? WHERE id = ?").run(nowIso(), ctx.job.recording_id);
  ctx.app.events.publish("recording.updated", { id: ctx.job.recording_id });
  return { kind: "completed", outputPath: out } satisfies StageOutcome;
};

export async function cleanupIntermediates(recordingsDir: string, recordingId: string) {
  const d = path.join(recordingsDir, recordingId, "work");
  let freed = 0;
  try {
    for (const f of await fsp.readdir(d)) {
      const p = path.join(d, f);
      freed += (await fsp.stat(p)).size;
      await fsp.rm(p, { force: true, recursive: true });
    }
    await fsp.rm(d, { recursive: true, force: true });
  } catch {
    /* nothing to clean */
  }
  return freed;
}
