import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Transform, type Readable } from "node:stream";
import { z } from "zod";
import type { DB } from "../db/index.js";
import type { Settings } from "../settings.js";
import { AppError, badRequest, conflict, freeBytes, notFound, nowIso, safeLocalName, uuid } from "../lib/util.js";

export const ALLOWED_TYPES: Record<string, string[]> = {
  mp3: ["audio/mpeg", "audio/mp3"],
  wav: ["audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave"],
  m4a: ["audio/mp4", "audio/x-m4a", "audio/m4a", "audio/aac"],
  flac: ["audio/flac", "audio/x-flac"],
  ogg: ["audio/ogg", "application/ogg"],
  opus: ["audio/opus", "audio/ogg"],
  mp4: ["video/mp4", "audio/mp4"],
};

/** Hard ceiling for a single HTTP chunk request: always < 100 MB. */
export const MAX_CHUNK_BYTES = 48 * 1024 * 1024;

export const uploadOptionsSchema = z.object({
  title: z.string().trim().max(200).optional(),
  language: z.enum(["auto", "zh", "en"]).default("auto"),
  vocabulary: z.string().max(4000).default(""),
  noteTemplate: z.enum(["none", "meeting", "class"]).default("none"),
  projectId: z.string().uuid().nullable().optional(),
  recordedAt: z.string().datetime({ offset: true }).nullable().optional(),
  autoExport: z.boolean().optional(),
});
export type UploadOptions = z.infer<typeof uploadOptionsSchema>;

export const createUploadSchema = z.object({
  filename: z.string().min(1).max(500),
  size: z.number().int().positive(),
  mimeType: z.string().max(100).optional().default(""),
  lastModified: z.number().int().optional(),
  fingerprint: z.string().max(300).optional(),
  options: uploadOptionsSchema.default(uploadOptionsSchema.parse({})),
});

export function chooseChunkSize(size: number, s: Settings["upload"]): number {
  const pick = size >= s.largeThreshold ? s.largeChunk : size >= s.mediumThreshold ? s.mediumChunk : s.smallChunk;
  return Math.min(pick, MAX_CHUNK_BYTES);
}

export function extensionOf(filename: string): string {
  return path.extname(filename).slice(1).toLowerCase();
}

export interface UploadSessionRow {
  id: string;
  owner_id: string;
  filename: string;
  safe_name: string;
  mime_type: string | null;
  extension: string;
  size_bytes: number;
  chunk_size: number;
  total_chunks: number;
  fingerprint: string | null;
  last_modified: number | null;
  options: string;
  status: string;
  received_bytes: number;
  sha256: string | null;
  recording_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

export interface CompletedUpload {
  session: UploadSessionRow;
  recordingId: string;
  created: boolean;
}

export type RecordingFactory = (args: {
  session: UploadSessionRow;
  options: UploadOptions;
  sourcePath: string;
  sha256: string;
  recordingId: string;
}) => void;

export class UploadService {
  constructor(
    private db: DB,
    private dirs: { uploads: string; recordings: string },
    private settings: () => Settings,
    private createRecording: RecordingFactory,
  ) {}

  private sessionDir(id: string) {
    // id is a server-generated UUID; validate anyway before touching the filesystem.
    if (!/^[0-9a-f-]{36}$/.test(id)) throw badRequest("invalid session id");
    return path.join(this.dirs.uploads, id);
  }

  private load(owner: string, id: string): UploadSessionRow {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw notFound("upload session");
    const row = this.db.prepare("SELECT * FROM upload_sessions WHERE id = ?").get(id) as UploadSessionRow | undefined;
    if (!row || row.owner_id !== owner) throw notFound("upload session");
    return row;
  }

  receivedIndices(id: string): number[] {
    return (this.db.prepare("SELECT chunk_index FROM upload_chunks WHERE session_id = ? ORDER BY chunk_index").all(id) as any[]).map(
      (r) => r.chunk_index,
    );
  }

  describe(row: UploadSessionRow) {
    return {
      id: row.id,
      filename: row.filename,
      size: row.size_bytes,
      chunkSize: row.chunk_size,
      totalChunks: row.total_chunks,
      status: row.status,
      receivedBytes: row.received_bytes,
      receivedChunks: this.receivedIndices(row.id),
      recordingId: row.recording_id,
      fingerprint: row.fingerprint,
      error: row.error,
      expiresAt: row.expires_at,
      maxConcurrency: this.settings().upload.concurrency,
    };
  }

  async create(owner: string, input: z.infer<typeof createUploadSchema>) {
    const s = this.settings().upload;
    const ext = extensionOf(input.filename);
    if (!ALLOWED_TYPES[ext]) throw new AppError(415, "unsupported_type", `Unsupported file type: .${ext || "(none)"}`);
    if (input.size > s.maxFileBytes)
      throw new AppError(413, "too_large", `File exceeds the ${Math.round(s.maxFileBytes / 1024 ** 3)} GiB limit`);
    const mime = input.mimeType?.toLowerCase() ?? "";
    if (mime && !ALLOWED_TYPES[ext].includes(mime) && mime !== "application/octet-stream")
      throw new AppError(415, "unsupported_type", `MIME type ${mime} does not match .${ext}`);

    // Resume: same owner + same file fingerprint + still active → hand back the existing session.
    if (input.fingerprint) {
      const existing = this.db
        .prepare(
          "SELECT * FROM upload_sessions WHERE owner_id = ? AND fingerprint = ? AND size_bytes = ? AND status IN ('active','assembling') AND expires_at > ? ORDER BY created_at DESC LIMIT 1",
        )
        .get(owner, input.fingerprint, input.size, nowIso()) as UploadSessionRow | undefined;
      if (existing) return { ...this.describe(existing), resumed: true };
    }

    await fsp.mkdir(this.dirs.uploads, { recursive: true });
    const free = await freeBytes(this.dirs.uploads);
    // chunks + assembled file + normalised wav need roughly 2.5× the upload size plus a safety margin.
    const need = input.size * 2.5 + this.settings().storage.minFreeBytes;
    if (free < need)
      throw new AppError(507, "insufficient_storage", `Not enough disk space (free ${(free / 1024 ** 3).toFixed(1)} GiB)`);

    const chunkSize = chooseChunkSize(input.size, s);
    const id = uuid();
    const now = nowIso();
    const row: UploadSessionRow = {
      id,
      owner_id: owner,
      filename: input.filename.slice(0, 500),
      safe_name: safeLocalName(input.filename, `upload.${ext}`),
      mime_type: mime || null,
      extension: ext,
      size_bytes: input.size,
      chunk_size: chunkSize,
      total_chunks: Math.ceil(input.size / chunkSize),
      fingerprint: input.fingerprint ?? null,
      last_modified: input.lastModified ?? null,
      options: JSON.stringify(input.options),
      status: "active",
      received_bytes: 0,
      sha256: null,
      recording_id: null,
      error: null,
      created_at: now,
      updated_at: now,
      expires_at: new Date(Date.now() + s.sessionTtlHours * 3600_000).toISOString(),
    };
    await fsp.mkdir(this.sessionDir(id), { recursive: true });
    this.db
      .prepare(
        `INSERT INTO upload_sessions (id, owner_id, filename, safe_name, mime_type, extension, size_bytes, chunk_size, total_chunks,
          fingerprint, last_modified, options, status, received_bytes, created_at, updated_at, expires_at)
         VALUES (@id, @owner_id, @filename, @safe_name, @mime_type, @extension, @size_bytes, @chunk_size, @total_chunks,
          @fingerprint, @last_modified, @options, @status, @received_bytes, @created_at, @updated_at, @expires_at)`,
      )
      .run(row);
    return { ...this.describe(row), resumed: false };
  }

  get(owner: string, id: string) {
    return this.describe(this.load(owner, id));
  }

  listActive(owner: string) {
    const rows = this.db
      .prepare("SELECT * FROM upload_sessions WHERE owner_id = ? AND status IN ('active','assembling') AND expires_at > ? ORDER BY created_at DESC")
      .all(owner, nowIso()) as UploadSessionRow[];
    return rows.map((r) => this.describe(r));
  }

  expectedChunkSize(row: UploadSessionRow, index: number) {
    const offset = index * row.chunk_size;
    return Math.min(row.chunk_size, row.size_bytes - offset);
  }

  /**
   * Receive one chunk. Idempotent: re-sending a chunk with the same checksum is a no-op,
   * a different checksum atomically replaces the previous copy (client-side retry after corruption).
   */
  async putChunk(owner: string, id: string, index: number, body: Readable, declaredSha: string) {
    const row = this.load(owner, id);
    if (row.status !== "active") throw conflict(`Upload is ${row.status}`);
    if (Date.parse(row.expires_at) < Date.now()) throw new AppError(410, "expired", "Upload session expired");
    if (!Number.isInteger(index) || index < 0 || index >= row.total_chunks) throw badRequest("chunk index out of range");
    if (!/^[0-9a-f]{64}$/.test(declaredSha)) throw badRequest("X-Chunk-Sha256 header must be a hex SHA-256");
    const expected = this.expectedChunkSize(row, index);

    const existing = this.db
      .prepare("SELECT sha256 FROM upload_chunks WHERE session_id = ? AND chunk_index = ?")
      .get(id, index) as { sha256: string } | undefined;
    const dir = this.sessionDir(id);
    const final = path.join(dir, `chunk-${String(index).padStart(6, "0")}`);
    if (existing && existing.sha256 === declaredSha && fs.existsSync(final)) {
      body.resume();
      return { index, duplicate: true, ...this.progress(id, row) };
    }

    const tmp = `${final}.${uuid()}.part`;
    const hash = createHash("sha256");
    let received = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        received += chunk.length;
        if (received > expected) return cb(new AppError(413, "chunk_too_large", "Chunk larger than expected"));
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    try {
      await pipeline(body, meter, fs.createWriteStream(tmp, { flags: "wx" }));
      if (received !== expected) throw badRequest(`Chunk ${index} size ${received} != expected ${expected}`);
      const got = hash.digest("hex");
      if (got !== declaredSha) throw new AppError(422, "checksum_mismatch", `Chunk ${index} checksum mismatch`);
      const fh = await fsp.open(tmp, "r+");
      await fh.sync();
      await fh.close();
      await fsp.rename(tmp, final);
    } catch (e: any) {
      await fsp.rm(tmp, { force: true });
      if (e.code === "ENOSPC") throw new AppError(507, "insufficient_storage", "Disk full while receiving chunk");
      throw e;
    }

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO upload_chunks (session_id, chunk_index, offset, size, sha256, received_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(session_id, chunk_index) DO UPDATE SET sha256 = excluded.sha256, size = excluded.size, received_at = excluded.received_at`,
        )
        .run(id, index, index * row.chunk_size, expected, declaredSha, nowIso());
      this.db
        .prepare(
          "UPDATE upload_sessions SET received_bytes = (SELECT COALESCE(SUM(size),0) FROM upload_chunks WHERE session_id = ?), updated_at = ? WHERE id = ?",
        )
        .run(id, nowIso(), id);
    })();
    return { index, duplicate: false, ...this.progress(id, row) };
  }

  private progress(id: string, row: UploadSessionRow) {
    const r = this.db.prepare("SELECT received_bytes FROM upload_sessions WHERE id = ?").get(id) as any;
    return { receivedBytes: r.received_bytes as number, size: row.size_bytes };
  }

  /** Verify every chunk, stream-assemble into the recording directory, then create recording + job. */
  async complete(owner: string, id: string): Promise<CompletedUpload> {
    const row = this.load(owner, id);
    if (row.status === "completed" && row.recording_id) return { session: row, recordingId: row.recording_id, created: false };
    const claimed = this.db
      .prepare("UPDATE upload_sessions SET status = 'assembling', updated_at = ? WHERE id = ? AND status = 'active'")
      .run(nowIso(), id);
    if (claimed.changes === 0) throw conflict(`Upload is ${row.status}; cannot complete now`);

    try {
      const chunks = this.db
        .prepare("SELECT chunk_index, size, sha256 FROM upload_chunks WHERE session_id = ? ORDER BY chunk_index")
        .all(id) as { chunk_index: number; size: number; sha256: string }[];
      const missing: number[] = [];
      for (let i = 0, j = 0; i < row.total_chunks; i++) {
        if (chunks[j]?.chunk_index === i) j++;
        else missing.push(i);
      }
      if (missing.length) throw new AppError(409, "incomplete", `Missing ${missing.length} chunk(s)`, { missing: missing.slice(0, 100) });
      const total = chunks.reduce((a, c) => a + c.size, 0);
      if (total !== row.size_bytes) throw new AppError(409, "size_mismatch", `Received ${total} bytes, expected ${row.size_bytes}`);

      const recordingId = uuid();
      const recDir = path.join(this.dirs.recordings, recordingId);
      await fsp.mkdir(recDir, { recursive: true });
      const target = path.join(recDir, `source.${row.extension}`);
      const partial = `${target}.part`;
      const whole = createHash("sha256");
      const out = fs.createWriteStream(partial, { flags: "wx" });
      const dir = this.sessionDir(id);
      try {
        for (const c of chunks) {
          const file = path.join(dir, `chunk-${String(c.chunk_index).padStart(6, "0")}`);
          const h = createHash("sha256");
          const verify = new Transform({
            transform(buf: Buffer, _e, cb) {
              h.update(buf);
              whole.update(buf);
              cb(null, buf);
            },
          });
          await pipeline(fs.createReadStream(file), verify, out, { end: false });
          if (h.digest("hex") !== c.sha256) throw new AppError(422, "checksum_mismatch", `Stored chunk ${c.chunk_index} is corrupt`);
        }
        await new Promise<void>((res, rej) => out.end((err?: Error | null) => (err ? rej(err) : res())));
        const fh = await fsp.open(partial, "r+");
        await fh.sync();
        await fh.close();
        const st = await fsp.stat(partial);
        if (st.size !== row.size_bytes) throw new AppError(422, "size_mismatch", "Assembled size mismatch");
        await fsp.rename(partial, target);
      } catch (e: any) {
        out.destroy();
        await fsp.rm(recDir, { recursive: true, force: true });
        if (e.code === "ENOSPC") throw new AppError(507, "insufficient_storage", "Disk full while assembling upload");
        throw e;
      }
      const digest = whole.digest("hex");
      const options = uploadOptionsSchema.parse(JSON.parse(row.options));

      this.db.transaction(() => {
        this.createRecording({ session: row, options, sourcePath: target, sha256: digest, recordingId });
        this.db
          .prepare("UPDATE upload_sessions SET status = 'completed', sha256 = ?, recording_id = ?, updated_at = ? WHERE id = ?")
          .run(digest, recordingId, nowIso(), id);
      })();
      await fsp.rm(dir, { recursive: true, force: true });
      const updated = this.load(owner, id);
      return { session: updated, recordingId, created: true };
    } catch (e: any) {
      // Incomplete uploads go back to active so the client can fill the gaps; corruption marks failure.
      const recoverable = e instanceof AppError && ["incomplete", "size_mismatch"].includes(e.code);
      this.db
        .prepare("UPDATE upload_sessions SET status = ?, error = ?, updated_at = ? WHERE id = ?")
        .run(recoverable ? "active" : "failed", String(e.message).slice(0, 500), nowIso(), id);
      throw e;
    }
  }

  async cancel(owner: string, id: string) {
    const row = this.load(owner, id);
    if (row.status === "completed") throw conflict("Upload already completed");
    this.db.prepare("UPDATE upload_sessions SET status = 'cancelled', updated_at = ? WHERE id = ?").run(nowIso(), id);
    await fsp.rm(this.sessionDir(id), { recursive: true, force: true });
    return { ok: true };
  }

  /** Remove chunk data for expired / failed / cancelled sessions. Returns bytes freed. */
  async cleanup(olderThanHours?: number): Promise<{ sessions: number; bytes: number }> {
    const cutoff = olderThanHours !== undefined ? new Date(Date.now() - olderThanHours * 3600_000).toISOString() : nowIso();
    const rows = this.db
      .prepare(
        `SELECT id FROM upload_sessions WHERE (status IN ('failed','cancelled') AND updated_at < ?) OR (status = 'active' AND expires_at < ?)`,
      )
      .all(cutoff, nowIso()) as { id: string }[];
    let bytes = 0;
    for (const r of rows) {
      const dir = this.sessionDir(r.id);
      try {
        for (const f of await fsp.readdir(dir)) bytes += (await fsp.stat(path.join(dir, f))).size;
      } catch {
        /* already gone */
      }
      await fsp.rm(dir, { recursive: true, force: true });
      this.db.prepare("DELETE FROM upload_chunks WHERE session_id = ?").run(r.id);
      this.db
        .prepare("UPDATE upload_sessions SET status = CASE WHEN status = 'active' THEN 'cancelled' ELSE status END, received_bytes = 0, updated_at = ? WHERE id = ?")
        .run(nowIso(), r.id);
    }
    return { sessions: rows.length, bytes };
  }
}
