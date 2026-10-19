import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export const uuid = () => randomUUID();
export const nowIso = () => new Date().toISOString();

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new AppError(404, "not_found", `${what} not found`);
export const badRequest = (msg: string, details?: unknown) => new AppError(400, "bad_request", msg, details);
export const conflict = (msg: string, details?: unknown) => new AppError(409, "conflict", msg, details);

/** Write a file atomically: temp file in the same dir, fsync, rename, fsync dir. */
export async function writeFileAtomic(file: string, data: string | Buffer) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fh = await fsp.open(tmp, "w");
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fsp.rename(tmp, file);
  try {
    const dh = await fsp.open(path.dirname(file), "r");
    await dh.sync();
    await dh.close();
  } catch {
    /* directory fsync is best effort */
  }
}

export async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8")) as T;
  } catch (e: any) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

export const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

export async function sha256File(file: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) h.update(chunk as Buffer);
  return h.digest("hex");
}

export async function dirSize(dir: string): Promise<number> {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(p);
    else if (e.isFile()) total += (await fsp.stat(p).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

export async function freeBytes(dir: string): Promise<number> {
  const s = await fsp.statfs(dir);
  return Number(s.bavail) * Number(s.bsize);
}

/** Make a user-supplied filename safe for local storage (never used as a path component without this). */
export function safeLocalName(name: string, fallback = "file"): string {
  const base = path.basename(name.replace(/\\/g, "/")).normalize("NFC");
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[/\\:*?"<>|]/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 180);
  return cleaned || fallback;
}

export function msToClock(ms: number, withMs = false, sep = "."): string {
  const neg = ms < 0;
  ms = Math.max(0, Math.round(Math.abs(ms)));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  const base = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return (neg ? "-" : "") + (withMs ? `${base}${sep}${String(r).padStart(3, "0")}` : base);
}

export function json<T>(v: string | null | undefined, fallback: T): T {
  if (!v) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Redact likely-sensitive values before logging. Transcript text never goes to logs. */
export function redact(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(redact);
  if (obj && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (/pass|token|secret|cookie|authorization|text|transcript|markdown|prompt|content/i.test(k)) out[k] = "[redacted]";
      else out[k] = redact(v);
    }
    return out;
  }
  return obj;
}
