import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { AppError, writeFileAtomic } from "../lib/util.js";

export interface VaultBackend {
  readonly kind: "filesystem" | "livesync-mcp";
  check(): Promise<{ ok: boolean; writable: boolean; detail: string }>;
  read(p: string): Promise<string | null>;
  exists(p: string): Promise<boolean>;
  /** Create only — must fail if the file exists (callers decide on overwrite explicitly). */
  create(p: string, content: string): Promise<void>;
  overwrite(p: string, content: string): Promise<void>;
  move(from: string, to: string): Promise<void>;
  remove(p: string): Promise<void>;
  listFolders(): Promise<string[]>;
  listNotes(folder: string): Promise<string[]>;
}

// ---------------------------------------------------------------------------

/** Vault mounted on this host. Every path is resolved and re-checked against the root (symlinks included). */
export class FsVaultBackend implements VaultBackend {
  readonly kind = "filesystem" as const;
  constructor(private root: string) {}

  private async resolve(rel: string, forWrite = false): Promise<string> {
    const rootReal = await fsp.realpath(this.root);
    const abs = path.resolve(rootReal, rel);
    if (abs !== rootReal && !abs.startsWith(rootReal + path.sep)) throw new AppError(400, "invalid_vault_path", "Path escapes the vault");
    // check the deepest existing ancestor's real path, so a symlinked folder cannot point outside
    let probe = forWrite ? path.dirname(abs) : abs;
    while (!fs.existsSync(probe) && probe !== rootReal) probe = path.dirname(probe);
    const real = await fsp.realpath(probe);
    if (real !== rootReal && !real.startsWith(rootReal + path.sep)) throw new AppError(400, "invalid_vault_path", "Path resolves outside the vault");
    return abs;
  }

  async check() {
    try {
      const st = await fsp.stat(this.root);
      if (!st.isDirectory()) return { ok: false, writable: false, detail: "Vault root is not a directory" };
      const hasObsidian = fs.existsSync(path.join(this.root, ".obsidian"));
      try {
        await fsp.access(this.root, fs.constants.W_OK);
      } catch {
        return { ok: true, writable: false, detail: "Vault is read-only for the service user" };
      }
      return { ok: true, writable: true, detail: hasObsidian ? "Obsidian vault found" : "Folder found (no .obsidian directory — is this the vault root?)" };
    } catch (e: any) {
      return { ok: false, writable: false, detail: e.code === "ENOENT" ? "Vault root does not exist on this host (mount it or use LiveSync)" : String(e.message) };
    }
  }

  async read(rel: string) {
    try {
      return await fsp.readFile(await this.resolve(rel), "utf8");
    } catch (e: any) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
  }

  async exists(rel: string) {
    return fs.existsSync(await this.resolve(rel));
  }

  async create(rel: string, content: string) {
    const abs = await this.resolve(rel, true);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    const fh = await fsp.open(abs, "wx").catch((e) => {
      if (e.code === "EEXIST") throw new AppError(409, "exists", `Note already exists: ${rel}`);
      throw e;
    });
    try {
      await fh.writeFile(content, "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
  }

  async overwrite(rel: string, content: string) {
    const abs = await this.resolve(rel, true);
    await writeFileAtomic(abs, content);
  }

  async move(from: string, to: string) {
    const a = await this.resolve(from);
    const b = await this.resolve(to, true);
    if (fs.existsSync(b)) throw new AppError(409, "exists", `Target exists: ${to}`);
    await fsp.mkdir(path.dirname(b), { recursive: true });
    await fsp.rename(a, b);
  }

  async remove(rel: string) {
    await fsp.rm(await this.resolve(rel), { force: true });
  }

  async listFolders() {
    const out: string[] = [];
    const walk = async (dir: string, rel: string, depth: number) => {
      if (depth > 6) return;
      for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (!e.isDirectory() || e.name.startsWith(".")) continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        out.push(r);
        await walk(path.join(dir, e.name), r, depth + 1);
      }
    };
    await walk(this.root, "", 0);
    return out;
  }

  async listNotes(folder: string) {
    const abs = await this.resolve(folder);
    const items = await fsp.readdir(abs, { withFileTypes: true }).catch(() => []);
    return items.filter((e) => e.isFile() && e.name.endsWith(".md")).map((e) => `${folder}/${e.name}`);
  }
}

// ---------------------------------------------------------------------------

/** Minimal MCP (streamable HTTP) client for obsidian-sync-mcp, which writes straight into LiveSync CouchDB. */
export class McpClient {
  private session: string | null = null;
  private nextId = 1;
  constructor(
    private url: string,
    private token: string,
    private timeoutMs = 30_000,
  ) {}

  private async post(body: unknown, withSession = true): Promise<{ json: any; headers: Headers }> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(withSession && this.session ? { "mcp-session-id": this.session } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (res.status === 404 && withSession && this.session) {
      this.session = null;
      throw Object.assign(new Error("session expired"), { retrySession: true });
    }
    if (!res.ok) throw new AppError(502, "vault_backend", `Obsidian MCP HTTP ${res.status}`);
    const text = await res.text();
    if (!text.trim()) return { json: null, headers: res.headers };
    if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
      const datas = text
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim());
      const last = datas.map((d) => JSON.parse(d)).find((m) => "result" in m || "error" in m);
      return { json: last ?? null, headers: res.headers };
    }
    return { json: JSON.parse(text), headers: res.headers };
  }

  private async init() {
    const { json, headers } = await this.post(
      { jsonrpc: "2.0", id: this.nextId++, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "transcriber", version: "0.1.0" } } },
      false,
    );
    if (!json?.result) throw new AppError(502, "vault_backend", "Obsidian MCP initialize failed");
    this.session = headers.get("mcp-session-id");
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!this.session) await this.init();
      try {
        const { json } = await this.post({ jsonrpc: "2.0", id: this.nextId++, method: "tools/call", params: { name, arguments: args } });
        if (json?.error) throw new AppError(502, "vault_backend", `Obsidian MCP error: ${json.error.message}`);
        const text = (json?.result?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
        if (json?.result?.isError) throw new AppError(502, "vault_backend", `Obsidian MCP ${name} failed: ${text.slice(0, 300)}`);
        return text;
      } catch (e: any) {
        if (e?.retrySession && attempt === 0) continue;
        throw e;
      }
    }
    throw new AppError(502, "vault_backend", "Obsidian MCP unavailable");
  }
}

const NOT_FOUND = /^Note not found:/;

export class LiveSyncMcpBackend implements VaultBackend {
  readonly kind = "livesync-mcp" as const;
  private client: McpClient;
  constructor(url: string, token: string) {
    this.client = new McpClient(url, token);
  }

  async check() {
    try {
      const t = await this.client.callTool("list_folders", {});
      const n = t.split("\n").filter((l) => l.startsWith("- ")).length;
      return { ok: true, writable: true, detail: `LiveSync vault reachable (${n} folders)` };
    } catch (e: any) {
      return { ok: false, writable: false, detail: String(e.message ?? e) };
    }
  }

  async read(p: string) {
    const t = await this.client.callTool("read_note", { path: p });
    if (NOT_FOUND.test(t)) return null;
    const i = t.indexOf("\n\n---\n\n");
    return i >= 0 && t.startsWith("[Open in Obsidian]") ? t.slice(i + 7) : t;
  }

  async exists(p: string) {
    const t = await this.client.callTool("get_note_metadata", { path: p });
    return !NOT_FOUND.test(t);
  }

  async create(p: string, content: string) {
    if (await this.exists(p)) throw new AppError(409, "exists", `Note already exists: ${p}`);
    await this.client.callTool("write_note", { path: p, content });
    await this.verify(p, content);
  }

  async overwrite(p: string, content: string) {
    await this.client.callTool("write_note", { path: p, content });
    await this.verify(p, content);
  }

  /** Read-after-write: the note must exist with exactly our content. */
  private async verify(p: string, content: string) {
    const back = await this.read(p);
    if (back === null) throw new AppError(502, "vault_backend", `Write to ${p} could not be verified`);
    if (back.replace(/\r\n/g, "\n").trimEnd() !== content.replace(/\r\n/g, "\n").trimEnd())
      throw new AppError(502, "vault_backend", `Content of ${p} differs after write`);
  }

  async move(from: string, to: string) {
    if (await this.exists(to)) throw new AppError(409, "exists", `Target exists: ${to}`);
    await this.client.callTool("move_note", { from, to });
    if (!(await this.exists(to))) throw new AppError(502, "vault_backend", `Move to ${to} could not be verified`);
  }

  async remove(p: string) {
    await this.client.callTool("delete_note", { path: p });
  }

  async listFolders() {
    const t = await this.client.callTool("list_folders", {});
    return t
      .split("\n")
      .map((l) => l.match(/^- (.+) \(\d+ notes?\)$/)?.[1])
      .filter((x): x is string => !!x && x !== "(root)");
  }

  async listNotes(folder: string) {
    const t = await this.client.callTool("list_notes", { folder, sort_by: "modified" });
    return [...t.matchAll(/\[([^\]]+\.md)\]\(obsidian:/g)].map((m) => m[1]).filter((p) => p.startsWith(folder + "/") && !p.slice(folder.length + 1).includes("/"));
  }
}

/** Optional read-only semantic search (obsidian-kb) used as extra filing context. */
export class SemanticSearch {
  private client: McpClient;
  constructor(url: string, token: string) {
    this.client = new McpClient(url, token, 20_000);
  }
  async search(query: string, limit = 8): Promise<{ path: string; title: string; snippet: string }[]> {
    const t = await this.client.callTool("search", { query: query.slice(0, 500), limit, mode: "hybrid" });
    try {
      const j = JSON.parse(t);
      const arr = Array.isArray(j) ? j : j.results ?? [];
      return arr.slice(0, limit).map((r: any) => ({ path: String(r.path ?? ""), title: String(r.title ?? ""), snippet: String(r.best_snippet ?? r.snippet ?? "").replace(/\s+/g, " ").slice(0, 200) }));
    } catch {
      return [...t.matchAll(/([^\n]+?\.md)/g)].slice(0, limit).map((m) => ({ path: m[1].replace(/^[-*\d.\s]+/, "").trim(), title: "", snippet: "" }));
    }
  }
}
