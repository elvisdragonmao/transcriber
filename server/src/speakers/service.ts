import type { AppContext } from "../context.js";
import { AppError, conflict, notFound, nowIso, uuid } from "../lib/util.js";
import { fromBlob, toBlob, cosine, centroid } from "../transcript/voiceprint.js";

export class SpeakerService {
  constructor(private ctx: AppContext) {}
  private get db() {
    return this.ctx.db;
  }

  list() {
    const rows = this.db
      .prepare(
        `SELECT s.*, (SELECT COUNT(*) FROM speaker_embeddings e WHERE e.speaker_id = s.id) AS embeddings,
           (SELECT COALESCE(SUM(speech_ms),0) FROM speaker_embeddings e WHERE e.speaker_id = s.id) AS enrolled_ms,
           (SELECT COUNT(DISTINCT recording_id) FROM recording_speakers rs WHERE rs.speaker_id = s.id) AS recordings
         FROM speakers s ORDER BY s.name COLLATE NOCASE`,
      )
      .all() as any[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      notes: r.notes,
      embeddings: r.embeddings,
      enrolledMs: r.enrolled_ms,
      recordings: r.recordings,
      aliases: (this.db.prepare("SELECT alias FROM speaker_aliases WHERE speaker_id = ?").all(r.id) as any[]).map((a) => a.alias),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  detail(id: string) {
    const s = this.list().find((x) => x.id === id);
    if (!s) throw notFound("speaker");
    const embeddings = (this.db
      .prepare(
        `SELECT e.id, e.recording_id, e.model, e.speech_ms, e.language, e.source, e.created_at, r.title FROM speaker_embeddings e LEFT JOIN recordings r ON r.id = e.recording_id
         WHERE e.speaker_id = ? ORDER BY e.created_at DESC`,
      )
      .all(id) as any[]).map((e) => ({ id: e.id, recordingId: e.recording_id, recordingTitle: e.title, model: e.model, speechMs: e.speech_ms, language: e.language, source: e.source, createdAt: e.created_at }));
    const appearances = this.db
      .prepare(
        `SELECT rs.id, rs.recording_id, rs.label, rs.assignment, rs.match_score, r.title, r.recorded_at FROM recording_speakers rs JOIN recordings r ON r.id = rs.recording_id
         WHERE rs.speaker_id = ? ORDER BY r.created_at DESC LIMIT 100`,
      )
      .all(id);
    return { ...s, embeddingList: embeddings, appearances };
  }

  create(name: string, notes?: string) {
    const n = name.trim().slice(0, 100);
    if (!n) throw new AppError(400, "bad_request", "Name required");
    if (this.db.prepare("SELECT 1 FROM speakers WHERE name = ?").get(n)) throw conflict(`Speaker "${n}" already exists`);
    const id = uuid();
    this.db.prepare("INSERT INTO speakers (id, name, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(id, n, notes ?? null, nowIso(), nowIso());
    return this.detail(id);
  }

  findOrCreate(name: string) {
    const n = name.trim().slice(0, 100);
    const row = (this.db.prepare("SELECT id FROM speakers WHERE name = ?").get(n) ??
      this.db.prepare("SELECT speaker_id AS id FROM speaker_aliases WHERE alias = ?").get(n)) as { id: string } | undefined;
    return row?.id ?? this.create(n).id;
  }

  update(id: string, patch: { name?: string; notes?: string | null; aliases?: string[] }) {
    if (!this.db.prepare("SELECT 1 FROM speakers WHERE id = ?").get(id)) throw notFound("speaker");
    this.db.transaction(() => {
      if (patch.name !== undefined) {
        const n = patch.name.trim().slice(0, 100);
        const other = this.db.prepare("SELECT id FROM speakers WHERE name = ? AND id != ?").get(n, id);
        if (other) throw conflict(`Another speaker is already called "${n}" — merge them instead`);
        this.db.prepare("UPDATE speakers SET name = ?, updated_at = ? WHERE id = ?").run(n, nowIso(), id);
      }
      if (patch.notes !== undefined) this.db.prepare("UPDATE speakers SET notes = ?, updated_at = ? WHERE id = ?").run(patch.notes, nowIso(), id);
      if (patch.aliases) {
        this.db.prepare("DELETE FROM speaker_aliases WHERE speaker_id = ?").run(id);
        for (const a of patch.aliases.map((x) => x.trim()).filter(Boolean).slice(0, 20)) {
          this.db.prepare("INSERT OR IGNORE INTO speaker_aliases (speaker_id, alias, created_at) VALUES (?, ?, ?)").run(id, a.slice(0, 100), nowIso());
        }
      }
    })();
    this.ctx.events.publish("speakers.updated", { id });
    return this.detail(id);
  }

  /** Merge `sourceId` into `targetId`: voiceprints, appearances and the old name (as alias) move over. */
  merge(sourceId: string, targetId: string) {
    if (sourceId === targetId) throw new AppError(400, "bad_request", "Cannot merge a speaker into itself");
    const src = this.db.prepare("SELECT * FROM speakers WHERE id = ?").get(sourceId) as any;
    if (!src || !this.db.prepare("SELECT 1 FROM speakers WHERE id = ?").get(targetId)) throw notFound("speaker");
    this.db.transaction(() => {
      this.db.prepare("UPDATE speaker_embeddings SET speaker_id = ? WHERE speaker_id = ?").run(targetId, sourceId);
      this.db.prepare("UPDATE recording_speakers SET speaker_id = ? WHERE speaker_id = ?").run(targetId, sourceId);
      this.db.prepare("UPDATE recording_speakers SET suggested_speaker_id = ? WHERE suggested_speaker_id = ?").run(targetId, sourceId);
      this.db.prepare("UPDATE OR IGNORE speaker_aliases SET speaker_id = ? WHERE speaker_id = ?").run(targetId, sourceId);
      this.db.prepare("DELETE FROM speakers WHERE id = ?").run(sourceId);
      this.db.prepare("INSERT OR IGNORE INTO speaker_aliases (speaker_id, alias, created_at) VALUES (?, ?, ?)").run(targetId, src.name, nowIso());
    })();
    this.ctx.events.publish("speakers.updated", { id: targetId });
    return this.detail(targetId);
  }

  delete(id: string) {
    const r = this.db.prepare("DELETE FROM speakers WHERE id = ?").run(id);
    if (!r.changes) throw notFound("speaker");
    this.db.prepare("UPDATE recording_speakers SET assignment = 'unknown' WHERE speaker_id IS NULL AND assignment IN ('auto','manual')").run();
    this.ctx.events.publish("speakers.updated", { id });
    return { ok: true };
  }

  deleteEmbedding(embeddingId: string) {
    const r = this.db.prepare("DELETE FROM speaker_embeddings WHERE id = ?").run(embeddingId);
    if (!r.changes) throw notFound("voiceprint");
    return { ok: true };
  }

  /**
   * Name a diarized speaker of one recording (manual correction). Optionally enroll its
   * embedding as a voiceprint so future recordings can match it.
   */
  assign(recordingSpeakerId: string, args: { speakerId?: string | null; newName?: string; label?: string; enroll?: boolean }) {
    const rs = this.db.prepare("SELECT * FROM recording_speakers WHERE id = ?").get(recordingSpeakerId) as any;
    if (!rs) throw notFound("recording speaker");
    let speakerId: string | null | undefined = args.speakerId;
    if (args.newName) speakerId = this.findOrCreate(args.newName);
    this.db.transaction(() => {
      if (args.label !== undefined) this.db.prepare("UPDATE recording_speakers SET label = ? WHERE id = ?").run(args.label.trim().slice(0, 60) || rs.label, rs.id);
      if (speakerId !== undefined) {
        if (speakerId && !this.db.prepare("SELECT 1 FROM speakers WHERE id = ?").get(speakerId)) throw notFound("speaker");
        // one person per recording: unassign another local speaker that had this person
        if (speakerId)
          this.db
            .prepare("UPDATE recording_speakers SET speaker_id = NULL, assignment = 'unknown' WHERE recording_id = ? AND speaker_id = ? AND id != ? AND assignment != 'manual'")
            .run(rs.recording_id, speakerId, rs.id);
        this.db.prepare("UPDATE recording_speakers SET speaker_id = ?, assignment = ? WHERE id = ?").run(speakerId, speakerId ? "manual" : "unknown", rs.id);
      }
      const enroll = args.enroll ?? !!speakerId;
      if (enroll && speakerId && rs.embedding && rs.clean_speech_ms >= this.ctx.settings.get().identify.minTotalCleanSec * 1000) {
        this.db.prepare("DELETE FROM speaker_embeddings WHERE recording_speaker_id = ?").run(rs.id);
        const lang = (this.db.prepare("SELECT language FROM transcripts WHERE recording_id = ?").get(rs.recording_id) as any)?.language ?? null;
        this.db
          .prepare(
            "INSERT INTO speaker_embeddings (id, speaker_id, recording_id, recording_speaker_id, model, dim, vector, speech_ms, language, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?)",
          )
          .run(uuid(), speakerId, rs.recording_id, rs.id, rs.embedding_model ?? this.ctx.settings.get().identify.model, fromBlob(rs.embedding).length, rs.embedding, rs.clean_speech_ms, lang, nowIso());
      }
      if (speakerId === null) this.db.prepare("DELETE FROM speaker_embeddings WHERE recording_speaker_id = ? AND source = 'manual'").run(rs.id);
    })();
    this.ctx.events.publish("recording.updated", { id: rs.recording_id });
    return this.db.prepare("SELECT id, speaker_id, assignment, label FROM recording_speakers WHERE id = ?").get(rs.id);
  }

  /** Store an embedding computed from an uploaded clip. */
  addClipEmbedding(speakerId: string, vector: number[], speechMs: number, model: string) {
    if (!this.db.prepare("SELECT 1 FROM speakers WHERE id = ?").get(speakerId)) throw notFound("speaker");
    const id = uuid();
    this.db
      .prepare("INSERT INTO speaker_embeddings (id, speaker_id, model, dim, vector, speech_ms, source, created_at) VALUES (?, ?, ?, ?, ?, ?, 'clip', ?)")
      .run(id, speakerId, model, vector.length, toBlob(vector), speechMs, nowIso());
    return { id };
  }

  /** Similarity of every recording speaker to every known person (for calibrating thresholds). */
  calibration() {
    const known = this.db.prepare("SELECT s.id, s.name, e.vector FROM speakers s JOIN speaker_embeddings e ON e.speaker_id = s.id").all() as any[];
    const by = new Map<string, { name: string; vs: Float32Array[] }>();
    for (const k of known) (by.get(k.id) ?? by.set(k.id, { name: k.name, vs: [] }).get(k.id)!).vs.push(fromBlob(k.vector));
    const cents = [...by.entries()].map(([id, v]) => ({ id, name: v.name, c: centroid(v.vs) }));
    const locals = this.db
      .prepare("SELECT rs.id, rs.speaker_id, rs.assignment, rs.embedding, r.title, t.language FROM recording_speakers rs JOIN recordings r ON r.id = rs.recording_id LEFT JOIN transcripts t ON t.recording_id = r.id WHERE rs.embedding IS NOT NULL AND rs.assignment = 'manual'")
      .all() as any[];
    const pairs: { same: boolean; score: number; language: string | null }[] = [];
    for (const l of locals) {
      const v = fromBlob(l.embedding);
      for (const c of cents) pairs.push({ same: c.id === l.speaker_id, score: Math.round(cosine(v, c.c) * 1000) / 1000, language: l.language });
    }
    return { pairs, note: "Scores of manually confirmed speakers against every enrolled person. Same-person scores include the speaker's own enrollment, so they are optimistic." };
  }
}
