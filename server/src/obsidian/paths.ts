import { AppError } from "../lib/util.js";

/** Characters Obsidian (and Windows/macOS sync targets) cannot hold in a file name, plus link-breaking ones. */
const BAD_CHARS = /[\\/:*?"<>|#^[\]\u0000-\u001f\u007f]/g;
const HAS_BAD = /[\\:*?"<>|#^[\]\u0000-\u001f\u007f]/;

export function sanitizeFileStem(name: string, max = 120): string {
  const s = name
    .normalize("NFC")
    .replace(BAD_CHARS, " ")
    .replace(/\.{2,}/g, ".")
    .replace(/\s+/g, " ")
    .replace(/^[\s.]+/, "")
    .replace(/[\s.]+$/, "");
  return [...s].slice(0, max).join("").trim() || "untitled";
}

export function sanitizeFolderName(name: string): string {
  return sanitizeFileStem(name, 80);
}

/**
 * Validate a vault-relative path produced by the backend (never by the LLM directly).
 * Rejects absolute paths, traversal, hidden segments, control chars, and anything
 * outside the allowed roots.
 */
export function validateVaultPath(rel: string, allowedRoots: string[], opts: { requireMd?: boolean } = {}): string {
  const p = rel.normalize("NFC").replace(/\\/g, "/");
  const fail = (why: string) => {
    throw new AppError(400, "invalid_vault_path", `Refused vault path (${why}): ${p.slice(0, 200)}`);
  };
  if (!p || p.length > 600) fail("empty or too long");
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) fail("absolute");
  const segs = p.split("/");
  for (const s of segs) {
    if (!s || s === "." || s === "..") fail("traversal / empty segment");
    if (s.startsWith(".")) fail("hidden segment");
    if (/[\u0000-\u001f\u007f]/.test(s)) fail("control characters");
    if (s !== s.trim()) fail("leading/trailing whitespace");
  }
  if (segs.some((s) => HAS_BAD.test(s))) fail("forbidden characters");
  const file = segs[segs.length - 1];
  if (opts.requireMd !== false && !file.endsWith(".md")) fail("not a markdown file");
  if (segs.slice(0, -1).some((s) => s.includes(".."))) fail("dots in folder");
  const inRoot = allowedRoots.some((root) => {
    const r = root.normalize("NFC").replace(/\/+$/, "");
    return p === r || p.startsWith(r + "/");
  });
  if (!inRoot) fail("outside the authorised folders");
  return p;
}

export function joinVault(...parts: string[]): string {
  return parts
    .map((x) => x.replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");
}

export function stemOf(path: string): string {
  return path.split("/").pop()!.replace(/\.md$/, "");
}

export function folderOf(path: string): string {
  return path.split("/").slice(0, -1).join("/");
}

/** "name.md" → "name v2.md", "name v3.md", ... */
export function versionedPath(path: string, n: number): string {
  return path.replace(/\.md$/, ` v${n}.md`);
}

export function fillTemplate(tpl: string, vars: { title: string; date: Date }): string {
  const d = vars.date;
  const pad = (n: number) => String(n).padStart(2, "0");
  const yyyy = String(d.getFullYear());
  return tpl
    .replace(/\{yymmdd\}/g, `${yyyy.slice(2)}${pad(d.getMonth() + 1)}${pad(d.getDate())}`)
    .replace(/\{yyyy-mm-dd\}/g, `${yyyy}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`)
    .replace(/\{title\}/g, vars.title);
}
