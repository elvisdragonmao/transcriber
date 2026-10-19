import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { api, ApiError } from "./api";

export interface UploadOptions {
  title?: string;
  language: "auto" | "zh" | "en";
  vocabulary: string;
  noteTemplate: "none" | "meeting" | "class";
  projectId?: string | null;
  autoExport?: boolean;
}

export type UploadState = "hashing" | "uploading" | "paused" | "verifying" | "done" | "error" | "cancelled" | "queued";

export interface UploadItem {
  key: string;
  file: File;
  options: UploadOptions;
  state: UploadState;
  sessionId: string | null;
  size: number;
  confirmedBytes: number;
  inflightBytes: number;
  chunkSize: number;
  totalChunks: number;
  received: Set<number>;
  error: string | null;
  recordingId: string | null;
  jobId: string | null;
  startedAt: number;
  speedBps: number | null;
  retries: number;
}

const ALLOWED = ["mp3", "wav", "m4a", "flac", "ogg", "opus", "mp4"];
const STORE = "transcriber.uploads.v1";
const MAX_CHUNK_RETRIES = 6;

export const fingerprint = (f: File) => `${f.name}:${f.size}:${f.lastModified}`;

export function validateFile(f: File): string | null {
  const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
  if (!ALLOWED.includes(ext)) return `不支援的格式 .${ext}（支援 ${ALLOWED.join(", ")}）`;
  if (f.size === 0) return "檔案是空的";
  return null;
}

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  // WebCrypto needs a secure context (HTTPS / localhost); fall back to a JS implementation otherwise.
  if (globalThis.crypto?.subtle) {
    const d = await crypto.subtle.digest("SHA-256", buf);
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  return bytesToHex(nobleSha256(new Uint8Array(buf)));
}

function putChunk(url: string, body: ArrayBuffer, sha: string, onProgress: (loaded: number) => void, signal: AbortSignal): Promise<any> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.setRequestHeader("x-chunk-sha256", sha);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      let data: any = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* ignore */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError(xhr.status, data?.error ?? "error", data?.message ?? `HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(new ApiError(0, "network", "網路中斷"));
    xhr.onabort = () => reject(new ApiError(0, "aborted", "aborted"));
    signal.addEventListener("abort", () => xhr.abort());
    xhr.send(body);
  });
}

type Listener = () => void;

/** Upload queue living outside React so uploads survive route changes. */
export class UploadManager {
  items: UploadItem[] = [];
  private listeners = new Set<Listener>();
  private controllers = new Map<string, AbortController>();
  private maxParallelFiles = 2;

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    this.items = [...this.items];
    for (const l of this.listeners) l();
  }
  private patchItem(key: string, p: Partial<UploadItem>) {
    const i = this.items.findIndex((x) => x.key === key);
    if (i >= 0) this.items[i] = { ...this.items[i], ...p };
    this.emit();
  }
  private item(key: string) {
    return this.items.find((x) => x.key === key)!;
  }

  /** Sessions remembered from before a page refresh: {fingerprint → session}. */
  remembered(): Record<string, { sessionId: string; name: string; size: number; options: UploadOptions; at: number }> {
    try {
      return JSON.parse(localStorage.getItem(STORE) ?? "{}");
    } catch {
      return {};
    }
  }
  private remember(f: File, sessionId: string | null, options?: UploadOptions) {
    try {
      const m = this.remembered();
      if (sessionId) m[fingerprint(f)] = { sessionId, name: f.name, size: f.size, options: options!, at: Date.now() };
      else delete m[fingerprint(f)];
      localStorage.setItem(STORE, JSON.stringify(m));
    } catch {
      /* storage unavailable: resume still works through the server-side fingerprint match */
    }
  }
  forget(fp: string) {
    try {
      const m = this.remembered();
      delete m[fp];
      localStorage.setItem(STORE, JSON.stringify(m));
    } catch {
      /* ignore */
    }
    this.emit();
  }

  add(files: File[], options: UploadOptions) {
    for (const file of files) {
      const err = validateFile(file);
      const key = `${fingerprint(file)}:${Math.random().toString(36).slice(2)}`;
      const prev = this.remembered()[fingerprint(file)];
      this.items.push({
        key,
        file,
        options: prev?.options ?? options,
        state: err ? "error" : "queued",
        sessionId: null,
        size: file.size,
        confirmedBytes: 0,
        inflightBytes: 0,
        chunkSize: 0,
        totalChunks: 0,
        received: new Set(),
        error: err,
        recordingId: null,
        jobId: null,
        startedAt: Date.now(),
        speedBps: null,
        retries: 0,
      });
    }
    this.emit();
    this.pump();
  }

  private pump() {
    const active = this.items.filter((i) => ["hashing", "uploading", "verifying"].includes(i.state)).length;
    let slots = this.maxParallelFiles - active;
    for (const it of this.items) {
      if (slots <= 0) break;
      if (it.state === "queued") {
        slots--;
        void this.run(it.key);
      }
    }
  }

  pause(key: string) {
    this.controllers.get(key)?.abort();
    this.patchItem(key, { state: "paused", inflightBytes: 0 });
    this.pump();
  }

  resume(key: string) {
    this.patchItem(key, { state: "queued", error: null });
    this.pump();
  }

  async cancel(key: string) {
    this.controllers.get(key)?.abort();
    const it = this.item(key);
    if (it.sessionId && it.state !== "done") await api("DELETE", `/api/uploads/${it.sessionId}`).catch(() => undefined);
    this.remember(it.file, null);
    this.patchItem(key, { state: "cancelled", inflightBytes: 0 });
    this.pump();
  }

  remove(key: string) {
    this.items = this.items.filter((i) => i.key !== key);
    this.emit();
  }

  private async run(key: string) {
    const ctrl = new AbortController();
    this.controllers.set(key, ctrl);
    const it0 = this.item(key);
    try {
      this.patchItem(key, { state: "uploading", startedAt: Date.now() });
      // create or resume (server matches the same fingerprint for this user)
      const s = await api<any>("POST", "/api/uploads", {
        filename: it0.file.name,
        size: it0.file.size,
        mimeType: it0.file.type,
        lastModified: it0.file.lastModified,
        fingerprint: fingerprint(it0.file),
        options: it0.options,
      });
      this.remember(it0.file, s.id, it0.options);
      const received = new Set<number>(s.receivedChunks);
      this.patchItem(key, {
        sessionId: s.id,
        chunkSize: s.chunkSize,
        totalChunks: s.totalChunks,
        received,
        confirmedBytes: s.receivedBytes,
      });
      if (s.status === "assembling" || s.status === "completed") return await this.finish(key, s.id);

      const todo = [...Array(s.totalChunks).keys()].filter((i) => !received.has(i));
      const inflight = new Map<number, number>();
      const t0 = Date.now();
      const base = s.receivedBytes;
      const updateInflight = () => {
        const it = this.item(key);
        const sent = [...inflight.values()].reduce((a, b) => a + b, 0);
        const elapsed = (Date.now() - t0) / 1000;
        this.patchItem(key, { inflightBytes: sent, speedBps: elapsed > 1 ? (it.confirmedBytes - base + sent) / elapsed : null });
      };
      const worker = async () => {
        while (todo.length) {
          if (ctrl.signal.aborted) return;
          const idx = todo.shift()!;
          const start = idx * s.chunkSize;
          const blob = it0.file.slice(start, Math.min(it0.file.size, start + s.chunkSize));
          const buf = await blob.arrayBuffer();
          const sha = await sha256Hex(buf);
          for (let attempt = 0; ; attempt++) {
            if (ctrl.signal.aborted) return;
            try {
              await putChunk(`/api/uploads/${s.id}/chunks/${idx}`, buf, sha, (l) => (inflight.set(idx, l), updateInflight()), ctrl.signal);
              inflight.delete(idx);
              const it = this.item(key);
              it.received.add(idx);
              this.patchItem(key, { confirmedBytes: it.confirmedBytes + buf.byteLength, received: it.received });
              break;
            } catch (e: any) {
              inflight.delete(idx);
              if (ctrl.signal.aborted) return;
              const fatal = e instanceof ApiError && [400, 401, 404, 409, 410, 413, 415, 507].includes(e.status);
              if (fatal || attempt >= MAX_CHUNK_RETRIES) throw e;
              this.patchItem(key, { retries: this.item(key).retries + 1 });
              await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** attempt)));
            }
          }
        }
      };
      const parallel = Math.max(1, Math.min(s.maxConcurrency ?? 4, 8));
      await Promise.all(Array.from({ length: parallel }, worker));
      if (ctrl.signal.aborted) return;
      await this.finish(key, s.id);
    } catch (e: any) {
      if (ctrl.signal.aborted) return;
      this.patchItem(key, { state: "error", error: e.message ?? String(e), inflightBytes: 0 });
    } finally {
      this.controllers.delete(key);
      this.pump();
    }
  }

  private async finish(key: string, sessionId: string) {
    this.patchItem(key, { state: "verifying", inflightBytes: 0 });
    const r = await api<any>("POST", `/api/uploads/${sessionId}/complete`, {});
    this.remember(this.item(key).file, null);
    this.patchItem(key, { state: "done", recordingId: r.recordingId, jobId: r.jobId, confirmedBytes: this.item(key).size });
  }
}

export const uploads = new UploadManager();
