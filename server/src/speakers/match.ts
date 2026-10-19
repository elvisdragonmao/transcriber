import type { DB } from "../db/index.js";
import type { Settings } from "../settings.js";
import { fromBlob, matchSpeakers, type KnownSpeaker } from "../transcript/voiceprint.js";

export function thresholdFor(language: string | null | undefined, s: Settings["identify"]) {
  const l = (language ?? "").toLowerCase();
  if (/chinese|cantonese|^zh/.test(l)) return s.thresholdZh;
  if (/english|^en/.test(l)) return s.thresholdEn;
  return s.thresholdOther;
}

/**
 * (Re)apply the voiceprint matching policy to one recording's diarized speakers.
 * Manual assignments are never touched. Called by `identify` (language may still be
 * unknown) and again by `merge`, once ASR has detected the dominant language, so the
 * language-specific threshold is the one that decides.
 */
export function applySpeakerMatching(db: DB, recordingId: string, language: string | null, s: Settings["identify"]) {
  const known: KnownSpeaker[] = [];
  const rows = db.prepare("SELECT s.id, s.name, e.vector FROM speakers s JOIN speaker_embeddings e ON e.speaker_id = s.id WHERE e.model = ?").all(s.model) as any[];
  for (const r of rows) {
    let k = known.find((x) => x.id === r.id);
    if (!k) known.push((k = { id: r.id, name: r.name, embeddings: [] }));
    k.embeddings.push(fromBlob(r.vector));
  }
  const locals = db.prepare("SELECT id, diar_index, embedding, clean_speech_ms, assignment FROM recording_speakers WHERE recording_id = ?").all(recordingId) as any[];
  const threshold = thresholdFor(language, s);
  const matches = matchSpeakers(
    locals.filter((l) => l.assignment !== "manual").map((l) => ({ key: l.diar_index, embedding: l.embedding ? fromBlob(l.embedding) : null, cleanMs: l.clean_speech_ms, consistency: null })),
    // a person already named manually in this recording cannot be auto-assigned to another speaker
    known.filter((k) => !locals.some((l) => l.assignment === "manual" && (db.prepare("SELECT speaker_id FROM recording_speakers WHERE id = ?").get(l.id) as any)?.speaker_id === k.id)),
    { threshold, minMargin: s.minMargin, suggestBelowBy: s.suggestBelowBy, minTotalCleanMs: s.minTotalCleanSec * 1000 },
  );
  const upd = db.prepare(
    "UPDATE recording_speakers SET speaker_id = ?, assignment = ?, match_score = ?, match_margin = ?, suggested_speaker_id = ? WHERE recording_id = ? AND diar_index = ? AND assignment != 'manual'",
  );
  db.transaction(() => {
    for (const m of matches) upd.run(m.speakerId, m.assignment, m.score, m.margin, m.suggestedId, recordingId, m.key);
  })();
  return { threshold, matches };
}
