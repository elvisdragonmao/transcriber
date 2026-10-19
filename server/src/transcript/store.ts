import type { DB } from "../db/index.js";
import { json, notFound, nowIso, uuid } from "../lib/util.js";
import type { AsrSeg, MergedSegment, MergedWord, Turn } from "./merge.js";
import type { ExportDoc } from "./exporters.js";

export const SPEAKER_COLORS = 10;

export interface RecordingSpeakerRow {
  id: string;
  recording_id: string;
  diar_index: number;
  label: string;
  speaker_id: string | null;
  assignment: string;
  match_score: number | null;
  match_margin: number | null;
  suggested_speaker_id: string | null;
  speech_ms: number;
  clean_speech_ms: number;
  color: number;
}

/** Replace the transcript of a recording atomically (idempotent: safe to re-run). */
export function saveMergedTranscript(
  db: DB,
  args: {
    recordingId: string;
    jobId: string;
    asr: AsrSeg[];
    turns: Turn[];
    segments: MergedSegment[];
    words: MergedWord[];
    modelInfo: Record<string, unknown>;
    languagesMs: Record<string, number>;
  },
) {
  const { recordingId } = args;
  const speakers = db.prepare("SELECT id, diar_index FROM recording_speakers WHERE recording_id = ?").all(recordingId) as {
    id: string;
    diar_index: number;
  }[];
  const rsByIndex = new Map(speakers.map((s) => [s.diar_index, s.id]));
  const ensureSpeaker = (idx: number) => {
    let id = rsByIndex.get(idx);
    if (!id) {
      id = uuid();
      db.prepare(
        "INSERT INTO recording_speakers (id, recording_id, diar_index, label, assignment, color) VALUES (?, ?, ?, ?, 'unknown', ?)",
      ).run(id, recordingId, idx, `Speaker ${idx + 1}`, idx % SPEAKER_COLORS);
      rsByIndex.set(idx, id);
    }
    return id;
  };
  const language = Object.entries(args.languagesMs).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  db.transaction(() => {
    db.prepare("DELETE FROM transcripts WHERE recording_id = ?").run(recordingId);
    db.prepare("DELETE FROM diarization_turns WHERE recording_id = ?").run(recordingId);
    const tid = uuid();
    db.prepare(
      "INSERT INTO transcripts (id, recording_id, job_id, language, languages, model_info, status, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'partial', 0, ?, ?)",
    ).run(tid, recordingId, args.jobId, language, JSON.stringify(args.languagesMs), JSON.stringify(args.modelInfo), nowIso(), nowIso());

    const insTurn = db.prepare("INSERT INTO diarization_turns (recording_id, diar_index, start_ms, end_ms) VALUES (?, ?, ?, ?)");
    for (const t of args.turns) insTurn.run(recordingId, t.speaker, t.start_ms, t.end_ms);

    const insAsr = db.prepare(
      "INSERT INTO asr_segments (transcript_id, idx, start_ms, end_ms, language, text_raw, text, aligned) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const asrIds = new Map<number, number>();
    for (const a of args.asr) {
      const r = insAsr.run(tid, a.idx, a.start_ms, a.end_ms, a.language ?? null, a.text_raw ?? "", a.text ?? "", 1);
      asrIds.set(a.idx, Number(r.lastInsertRowid));
    }

    const insSeg = db.prepare(
      `INSERT INTO transcript_segments (transcript_id, idx, start_ms, end_ms, recording_speaker_id, original_recording_speaker_id, speaker_status, overlap_speakers, text, text_original)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insWord = db.prepare(
      `INSERT INTO words (transcript_id, segment_id, asr_segment_id, idx, text, start_ms, end_ms, rel_start_ms, rel_end_ms, recording_speaker_id, aligned)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    args.segments.forEach((s, i) => {
      const rs = s.speaker !== null ? ensureSpeaker(s.speaker) : null;
      const overlap = s.overlapSpeakers.map((x) => ensureSpeaker(x));
      const r = insSeg.run(tid, i, s.start, s.end, rs, rs, s.status, overlap.length ? JSON.stringify(overlap) : null, s.text, s.text);
      const segId = Number(r.lastInsertRowid);
      s.words.forEach((w, wi) => {
        insWord.run(
          tid,
          segId,
          asrIds.get(w.asrIdx) ?? null,
          wi,
          w.text,
          w.start,
          w.end,
          w.relStart,
          w.relEnd,
          w.speaker !== null ? ensureSpeaker(w.speaker) : null,
          w.aligned ? 1 : 0,
        );
      });
    });
    // recompute speaking time per recording speaker
    const speech = new Map<number, number>();
    for (const t of args.turns) speech.set(t.speaker, (speech.get(t.speaker) ?? 0) + t.end_ms - t.start_ms);
    for (const [idx, ms] of speech) db.prepare("UPDATE recording_speakers SET speech_ms = ? WHERE id = ?").run(ms, ensureSpeaker(idx));
  })();
}

export function markTranscriptComplete(db: DB, recordingId: string) {
  db.prepare("UPDATE transcripts SET status = 'complete', updated_at = ? WHERE recording_id = ?").run(nowIso(), recordingId);
}

export function speakerDisplayName(db: DB, rs: { speaker_id: string | null; label: string } | undefined): string {
  if (!rs) return "Unknown Speaker";
  if (rs.speaker_id) {
    const s = db.prepare("SELECT name FROM speakers WHERE id = ?").get(rs.speaker_id) as { name: string } | undefined;
    if (s) return s.name;
  }
  return rs.label;
}

export function loadTranscriptView(db: DB, recordingId: string, opts: { words?: boolean } = {}) {
  const t = db.prepare("SELECT * FROM transcripts WHERE recording_id = ?").get(recordingId) as any;
  if (!t) return null;
  const speakers = db
    .prepare(
      `SELECT rs.*, s.name AS speaker_name, ss.name AS suggested_name
       FROM recording_speakers rs LEFT JOIN speakers s ON s.id = rs.speaker_id LEFT JOIN speakers ss ON ss.id = rs.suggested_speaker_id
       WHERE rs.recording_id = ? ORDER BY rs.diar_index`,
    )
    .all(recordingId)
    .map((r: any) => ({
      id: r.id,
      diarIndex: r.diar_index,
      label: r.label,
      speakerId: r.speaker_id,
      name: r.speaker_name ?? r.label,
      assignment: r.assignment,
      matchScore: r.match_score,
      matchMargin: r.match_margin,
      suggestedSpeakerId: r.suggested_speaker_id,
      suggestedName: r.suggested_name,
      speechMs: r.speech_ms,
      cleanSpeechMs: r.clean_speech_ms,
      color: r.color,
      hasEmbedding: !!r.embedding,
    }));
  const segments = db.prepare("SELECT * FROM transcript_segments WHERE transcript_id = ? ORDER BY start_ms, idx").all(t.id) as any[];
  let wordsBySeg = new Map<number, any[]>();
  if (opts.words) {
    const ws = db
      .prepare("SELECT id, segment_id, idx, text, start_ms, end_ms, aligned, recording_speaker_id FROM words WHERE transcript_id = ? ORDER BY segment_id, idx")
      .all(t.id) as any[];
    for (const w of ws) (wordsBySeg.get(w.segment_id) ?? wordsBySeg.set(w.segment_id, []).get(w.segment_id)!).push(w);
  }
  return {
    id: t.id,
    status: t.status,
    language: t.language,
    languages: json(t.languages, {}),
    modelInfo: json(t.model_info, {}),
    revision: t.revision,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
    speakers,
    segments: segments.map((s) => ({
      id: s.id,
      start: s.start_ms,
      end: s.end_ms,
      speakerId: s.recording_speaker_id,
      originalSpeakerId: s.original_recording_speaker_id,
      status: s.speaker_status,
      overlapSpeakers: json<string[]>(s.overlap_speakers, []),
      text: s.text,
      textOriginal: s.text_original,
      edited: !!s.edited_at,
      words: opts.words
        ? (wordsBySeg.get(s.id) ?? []).map((w) => ({ t: w.text, s: w.start_ms, e: w.end_ms, a: !!w.aligned }))
        : undefined,
    })),
  };
}

export function buildExportDoc(db: DB, recordingId: string): ExportDoc {
  const rec = db.prepare("SELECT * FROM recordings WHERE id = ?").get(recordingId) as any;
  if (!rec) throw notFound("recording");
  const view = loadTranscriptView(db, recordingId);
  if (!view) throw notFound("transcript");
  const names = new Map(view.speakers.map((s) => [s.id, s.name]));
  const segs = view.segments.map((s) => {
    let speaker = s.speakerId ? names.get(s.speakerId) ?? "Unknown Speaker" : "Unknown Speaker";
    if (s.status === "overlap" && s.overlapSpeakers.length) speaker = s.overlapSpeakers.map((id) => names.get(id) ?? "?").join(" / ");
    return { start: s.start, end: s.end, speaker, status: s.status, text: s.text };
  });
  const used = [...new Set(view.segments.map((s) => s.speakerId).filter(Boolean) as string[])];
  return {
    id: recordingId,
    title: rec.title,
    date: (rec.recorded_at ?? rec.created_at)?.slice(0, 10) ?? null,
    durationMs: rec.duration_ms,
    language: view.language,
    speakers: used.map((id) => names.get(id) ?? "Unknown Speaker"),
    segments: segs,
    model: view.modelInfo,
  };
}

export function editSegment(db: DB, segmentId: number, patch: { text?: string; recordingSpeakerId?: string | null }) {
  const seg = db.prepare("SELECT * FROM transcript_segments WHERE id = ?").get(segmentId) as any;
  if (!seg) throw notFound("segment");
  db.transaction(() => {
    if (patch.text !== undefined && patch.text !== seg.text) {
      db.prepare("INSERT INTO segment_revisions (segment_id, field, old_value, new_value, created_at) VALUES (?, 'text', ?, ?, ?)").run(
        segmentId,
        seg.text,
        patch.text,
        nowIso(),
      );
      db.prepare("UPDATE transcript_segments SET text = ?, edited_at = ? WHERE id = ?").run(patch.text, nowIso(), segmentId);
    }
    if (patch.recordingSpeakerId !== undefined && patch.recordingSpeakerId !== seg.recording_speaker_id) {
      if (patch.recordingSpeakerId) {
        const t = db.prepare("SELECT recording_id FROM transcripts WHERE id = ?").get(seg.transcript_id) as any;
        const rs = db.prepare("SELECT recording_id FROM recording_speakers WHERE id = ?").get(patch.recordingSpeakerId) as any;
        if (!rs || rs.recording_id !== t.recording_id) throw notFound("recording speaker");
      }
      db.prepare("INSERT INTO segment_revisions (segment_id, field, old_value, new_value, created_at) VALUES (?, 'speaker', ?, ?, ?)").run(
        segmentId,
        seg.recording_speaker_id,
        patch.recordingSpeakerId,
        nowIso(),
      );
      db.prepare("UPDATE transcript_segments SET recording_speaker_id = ?, speaker_status = 'manual', overlap_speakers = NULL, edited_at = ? WHERE id = ?").run(
        patch.recordingSpeakerId,
        nowIso(),
        segmentId,
      );
    }
    db.prepare("UPDATE transcripts SET revision = revision + 1, updated_at = ? WHERE id = ?").run(nowIso(), seg.transcript_id);
  })();
}
