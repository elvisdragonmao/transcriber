import type { DB } from "../db/index.js";
import type { AppConfig } from "../config.js";
import type { SettingsStore, Settings } from "../settings.js";
import { AppError, json, notFound, nowIso, sha256, uuid } from "../lib/util.js";
import { FsVaultBackend, LiveSyncMcpBackend, SemanticSearch, type VaultBackend } from "./backends.js";
import { fillTemplate, folderOf, joinVault, sanitizeFileStem, sanitizeFolderName, stemOf, validateVaultPath, versionedPath } from "./paths.js";
import { transcriptMarkdown } from "./markdown.js";
import { buildExportDoc } from "../transcript/store.js";

export interface Classification {
  document_type: string;
  detected_project: string | null;
  suggested_folder: string | null;
  new_folder_name: string | null;
  suggested_title: string;
  classification_confidence: number;
  classification_reason: string;
  evidence: string[];
}

export interface VaultContext {
  candidates: { folder: string; kind: string; notes: string[] }[];
  knownProjects: string[];
  related: { path: string; title: string; snippet: string }[];
}

export interface ExportResult {
  exportId: string;
  path: string;
  status: "written" | "pending_review";
  versioned: boolean;
  suggestedPath: string | null;
  uri: string;
}

const RESERVED = ["逐字稿", "待整理"];

export class ObsidianService {
  constructor(
    private db: DB,
    private settings: SettingsStore,
    private config: AppConfig,
    private backendOverride?: VaultBackend,
  ) {}

  private s(): Settings["obsidian"] {
    return this.settings.get().obsidian;
  }

  backend(): VaultBackend | null {
    if (this.backendOverride) return this.backendOverride;
    const s = this.s();
    if (s.backend === "filesystem" && s.vaultRoot) return new FsVaultBackend(s.vaultRoot);
    if (s.backend === "livesync-mcp" && this.config.obsidianMcpUrl && this.config.obsidianMcpToken)
      return new LiveSyncMcpBackend(this.config.obsidianMcpUrl, this.config.obsidianMcpToken);
    return null;
  }

  private requireBackend(): VaultBackend {
    const b = this.backend();
    if (!b) throw new AppError(409, "vault_not_configured", "Obsidian vault is not configured (Settings → Obsidian)");
    return b;
  }

  semantic(): SemanticSearch | null {
    if (!this.s().useSemanticSearch || !this.config.semanticMcpUrl || !this.config.semanticMcpToken) return null;
    return new SemanticSearch(this.config.semanticMcpUrl, this.config.semanticMcpToken);
  }

  uri(vaultPath: string): string {
    const name = this.s().vaultName;
    const file = vaultPath.replace(/\.md$/, "");
    return `obsidian://open?vault=${encodeURIComponent(name)}&file=${encodeURIComponent(file)}`;
  }

  async status() {
    const s = this.s();
    const b = this.backend();
    if (!b)
      return {
        backend: s.backend,
        configured: false,
        ok: false,
        writable: false,
        detail:
          s.backend === "livesync-mcp"
            ? "OBSIDIAN_MCP_URL / OBSIDIAN_MCP_TOKEN missing in the server environment"
            : s.backend === "filesystem"
              ? "Vault root path not set"
              : "No vault configured. The vault must be on this host (filesystem) or reachable through the LiveSync MCP.",
        transRootExists: false,
        transcriptFolderExists: false,
        vaultName: s.vaultName,
      };
    const c = await b.check();
    let folders: string[] = [];
    if (c.ok) folders = await b.listFolders().catch(() => []);
    return {
      backend: b.kind,
      configured: true,
      ok: c.ok,
      writable: c.writable,
      detail: c.detail,
      transRootExists: folders.includes(s.transRoot),
      transcriptFolderExists: folders.includes(s.transcriptFolder),
      vaultName: s.vaultName,
      semantic: !!this.semantic(),
    };
  }

  /** Detect vault roots on this host (folders containing .obsidian) for first-run setup. */
  static async detectLocalVaults(searchRoots: string[]): Promise<string[]> {
    const { default: fsp } = await import("node:fs/promises");
    const { default: path } = await import("node:path");
    const found: string[] = [];
    const walk = async (dir: string, depth: number) => {
      if (depth > 4 || found.length > 20) return;
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      if (entries.some((e) => e.isDirectory() && e.name === ".obsidian")) found.push(dir);
      for (const e of entries) if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules") await walk(path.join(dir, e.name), depth + 1);
    };
    for (const r of searchRoots) await walk(r, 0);
    return found;
  }

  /** Read-only scan used as filing context for the LLM. */
  async scanContext(queryText: string): Promise<VaultContext> {
    const b = this.backend();
    const s = this.s();
    if (!b) return { candidates: [], knownProjects: [], related: [] };
    const folders = await b.listFolders();
    const trans = s.transRoot;
    const transSubs = folders.filter((f) => folderOf(f) === trans && !RESERVED.includes(f.slice(trans.length + 1)));
    const candidates = [];
    for (const f of transSubs.slice(0, 60)) {
      const notes = (await b.listNotes(f).catch(() => [])).slice(0, 6).map((p) => stemOf(p));
      candidates.push({ folder: f, kind: "existing transcript project folder", notes });
    }
    const knownProjects = new Set<string>();
    for (const root of s.scanRoots) {
      if (root === trans) continue;
      for (const f of folders) {
        const rel = f.startsWith(root + "/") ? f.slice(root.length + 1) : null;
        if (rel && rel.split("/").length <= 2) knownProjects.add(rel.split("/").pop()!);
      }
    }
    let related: VaultContext["related"] = [];
    const sem = this.semantic();
    if (sem && queryText.trim()) related = await sem.search(queryText, 8).catch(() => []);
    this.syncProjects(transSubs);
    return { candidates, knownProjects: [...knownProjects].slice(0, 200), related };
  }

  private syncProjects(folders: string[]) {
    const ins = this.db.prepare(
      "INSERT INTO projects (id, name, vault_folder, kind, source, created_at, updated_at) VALUES (?, ?, ?, 'project', 'vault', ?, ?) ON CONFLICT(vault_folder) DO UPDATE SET updated_at = excluded.updated_at",
    );
    for (const f of folders) ins.run(uuid(), f.split("/").pop(), f, nowIso(), nowIso());
  }

  /** Decide where a generated note goes. Only the backend decides; the model only suggests. */
  decideFolder(c: Classification, candidates: string[]): { folder: string; status: "written" | "pending_review"; suggested: string | null } {
    const s = this.s();
    const suggestedExisting = c.suggested_folder && candidates.includes(c.suggested_folder) ? c.suggested_folder : null;
    if (suggestedExisting && c.classification_confidence >= s.autoFileConfidence) return { folder: suggestedExisting, status: "written", suggested: suggestedExisting };
    let suggested = suggestedExisting;
    if (!suggested && c.new_folder_name) suggested = joinVault(s.transRoot, sanitizeFolderName(c.new_folder_name));
    if (suggested) {
      try {
        validateVaultPath(suggested + "/x.md", s.allowedRoots);
      } catch {
        suggested = null; // the model's suggestion is only advice; drop anything unsafe
      }
    }
    return { folder: s.pendingFolder, status: "pending_review", suggested };
  }

  private recordExport(args: {
    recordingId: string;
    kind: "transcript" | "note";
    noteId?: string | null;
    path: string;
    content: string;
    status: "written" | "pending_review";
    suggestedPath?: string | null;
    classification?: unknown;
  }) {
    const id = uuid();
    const b = this.requireBackend();
    this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE obsidian_exports SET status = 'superseded', updated_at = ? WHERE recording_id = ? AND kind = ? AND COALESCE(note_id,'') = COALESCE(?, '') AND status IN ('written','pending_review') AND vault_path != ?",
        )
        .run(nowIso(), args.recordingId, args.kind, args.noteId ?? null, args.path);
      this.db.prepare("DELETE FROM obsidian_exports WHERE recording_id = ? AND vault_path = ? AND kind = ?").run(args.recordingId, args.path, args.kind);
      this.db
        .prepare(
          `INSERT INTO obsidian_exports (id, recording_id, kind, note_id, backend, vault_path, content_sha256, status, suggested_path, classification, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          args.recordingId,
          args.kind,
          args.noteId ?? null,
          b.kind,
          args.path,
          sha256(args.content.replace(/\r\n/g, "\n").trimEnd()),
          args.status,
          args.suggestedPath ?? null,
          args.classification ? JSON.stringify(args.classification) : null,
          nowIso(),
          nowIso(),
        );
    })();
    return id;
  }

  /**
   * Write without ever silently clobbering: an existing file is only replaced when it is our
   * own unchanged export (same sha) or the user explicitly confirmed overwrite; otherwise a
   * new versioned name is used.
   */
  private async safeWrite(target: string, content: string, overwrite: boolean): Promise<{ path: string; versioned: boolean }> {
    const b = this.requireBackend();
    const roots = this.s().allowedRoots;
    validateVaultPath(target, roots);
    const existing = await b.read(target);
    if (existing === null) {
      await b.create(target, content);
      return { path: target, versioned: false };
    }
    const own = this.db
      .prepare("SELECT content_sha256 FROM obsidian_exports WHERE vault_path = ? AND status IN ('written','pending_review') ORDER BY updated_at DESC LIMIT 1")
      .get(target) as { content_sha256: string } | undefined;
    const unchanged = own && own.content_sha256 === sha256(existing.replace(/\r\n/g, "\n").trimEnd());
    if (overwrite || unchanged) {
      await b.overwrite(target, content);
      return { path: target, versioned: false };
    }
    for (let n = 2; n < 100; n++) {
      const p = versionedPath(target, n);
      validateVaultPath(p, roots);
      if (!(await b.exists(p))) {
        await b.create(p, content);
        return { path: p, versioned: true };
      }
    }
    throw new AppError(409, "exists", "Too many versions of this note exist");
  }

  transcriptPath(recordingId: string): string {
    const rec = this.db.prepare("SELECT title, recorded_at, created_at FROM recordings WHERE id = ?").get(recordingId) as any;
    if (!rec) throw notFound("recording");
    const s = this.s();
    const stem = sanitizeFileStem(fillTemplate(s.transcriptName, { title: rec.title, date: new Date(rec.recorded_at ?? rec.created_at) }));
    return joinVault(s.transcriptFolder, `${stem}.md`);
  }

  currentExport(recordingId: string, kind: "transcript" | "note", noteId?: string | null) {
    return this.db
      .prepare(
        "SELECT * FROM obsidian_exports WHERE recording_id = ? AND kind = ? AND COALESCE(note_id,'') = COALESCE(?, '') AND status IN ('written','pending_review') ORDER BY updated_at DESC LIMIT 1",
      )
      .get(recordingId, kind, noteId ?? null) as any;
  }

  async exportTranscript(recordingId: string, opts: { overwrite?: boolean } = {}): Promise<ExportResult> {
    const doc = buildExportDoc(this.db, recordingId);
    const rec = this.db.prepare("SELECT * FROM recordings WHERE id = ?").get(recordingId) as any;
    const project = rec.project_id ? (this.db.prepare("SELECT name FROM projects WHERE id = ?").get(rec.project_id) as any)?.name ?? null : null;
    const notes = this.db
      .prepare("SELECT vault_path FROM obsidian_exports WHERE recording_id = ? AND kind = 'note' AND status IN ('written','pending_review')")
      .all(recordingId)
      .map((r: any) => stemOf(r.vault_path));
    const prev = this.currentExport(recordingId, "transcript");
    const target = prev?.vault_path ?? this.transcriptPath(recordingId);
    const content = transcriptMarkdown(doc, {
      type: rec.document_type ?? (rec.note_template === "class" ? "class" : rec.note_template === "meeting" ? "meeting" : "recording"),
      project,
      sourceAudio: rec.original_filename,
      created: prev?.created_at ?? nowIso(),
      tags: ["逐字稿", ...(rec.document_type ? [rec.document_type] : [])],
      relatedNotes: notes,
    });
    const w = await this.safeWrite(target, content, !!opts.overwrite);
    const id = this.recordExport({ recordingId, kind: "transcript", path: w.path, content, status: "written" });
    return { exportId: id, path: w.path, status: "written", versioned: w.versioned, suggestedPath: null, uri: this.uri(w.path) };
  }

  async exportNote(noteId: string, opts: { folder?: string; overwrite?: boolean } = {}): Promise<ExportResult> {
    const note = this.db.prepare("SELECT * FROM generated_notes WHERE id = ?").get(noteId) as any;
    if (!note) throw notFound("note");
    const s = this.s();
    const rec = this.db.prepare("SELECT * FROM recordings WHERE id = ?").get(note.recording_id) as any;
    const cls = json<{ classification: Classification; candidates: string[] } | null>(note.classification, null);
    let folder: string;
    let status: "written" | "pending_review";
    let suggested: string | null = null;
    if (opts.folder) {
      folder = opts.folder;
      status = "written";
    } else if (cls) {
      const d = this.decideFolder(cls.classification, cls.candidates ?? []);
      folder = d.folder;
      status = d.status;
      suggested = d.suggested;
    } else {
      folder = s.pendingFolder;
      status = "pending_review";
    }
    const tpl = note.template === "class" ? s.className : s.meetingName;
    const stem = sanitizeFileStem(fillTemplate(tpl, { title: rec.title, date: new Date(rec.recorded_at ?? rec.created_at) }));
    const target = joinVault(folder, `${stem}.md`);
    validateVaultPath(target, s.allowedRoots);
    const suggestedPath = suggested ? joinVault(suggested, `${stem}.md`) : null;
    const prev = this.currentExport(rec.id, "note", noteId);
    const w = await this.safeWrite(target, note.markdown, !!opts.overwrite);
    if (prev && prev.vault_path !== w.path) {
      // moved: remove our previous copy only if the user has not edited it since
      const b = this.requireBackend();
      const old = await b.read(prev.vault_path).catch(() => null);
      if (old !== null && sha256(old.replace(/\r\n/g, "\n").trimEnd()) === prev.content_sha256) await b.remove(prev.vault_path).catch(() => undefined);
    }
    const id = this.recordExport({ recordingId: rec.id, kind: "note", noteId, path: w.path, content: note.markdown, status, suggestedPath, classification: cls?.classification });
    if (status === "written" && folder !== s.pendingFolder) {
      const proj = this.db.prepare("SELECT id FROM projects WHERE vault_folder = ?").get(folder) as any;
      if (proj) this.db.prepare("UPDATE recordings SET project_id = ?, updated_at = ? WHERE id = ?").run(proj.id, nowIso(), rec.id);
      else {
        const pid = uuid();
        this.db
          .prepare("INSERT INTO projects (id, name, vault_folder, kind, source, created_at, updated_at) VALUES (?, ?, ?, 'project', 'ai', ?, ?)")
          .run(pid, folder.split("/").pop(), folder, nowIso(), nowIso());
        this.db.prepare("UPDATE recordings SET project_id = ?, updated_at = ? WHERE id = ?").run(pid, nowIso(), rec.id);
      }
    }
    return { exportId: id, path: w.path, status, versioned: w.versioned, suggestedPath, uri: this.uri(w.path) };
  }

  /** Move an exported note to another (validated) folder inside the authorised roots. */
  async moveNote(noteId: string, folder: string) {
    const s = this.s();
    const clean = folder
      .split("/")
      .map((x) => x.trim())
      .filter(Boolean)
      .join("/");
    validateVaultPath(joinVault(clean, "x.md"), s.allowedRoots);
    return this.exportNote(noteId, { folder: clean });
  }

  /** Explicit, confirmed deletion of a file this system wrote. Never touches files it did not create. */
  async deleteExportedFile(exportId: string) {
    const e = this.db.prepare("SELECT * FROM obsidian_exports WHERE id = ?").get(exportId) as any;
    if (!e) throw notFound("export");
    validateVaultPath(e.vault_path, this.s().allowedRoots);
    const b = this.requireBackend();
    await b.remove(e.vault_path);
    this.db.prepare("UPDATE obsidian_exports SET status = 'deleted', updated_at = ? WHERE id = ?").run(nowIso(), exportId);
    return { ok: true, path: e.vault_path };
  }

  async readExport(exportId: string) {
    const e = this.db.prepare("SELECT * FROM obsidian_exports WHERE id = ?").get(exportId) as any;
    if (!e) throw notFound("export");
    const content = await this.requireBackend().read(e.vault_path);
    return { path: e.vault_path, content, modifiedByUser: content !== null && sha256(content.replace(/\r\n/g, "\n").trimEnd()) !== e.content_sha256 };
  }

  listExports(recordingId: string) {
    return (this.db.prepare("SELECT * FROM obsidian_exports WHERE recording_id = ? ORDER BY created_at DESC").all(recordingId) as any[]).map((e) => ({
      id: e.id,
      kind: e.kind,
      noteId: e.note_id,
      backend: e.backend,
      path: e.vault_path,
      status: e.status,
      suggestedPath: e.suggested_path,
      classification: json(e.classification, null),
      createdAt: e.created_at,
      updatedAt: e.updated_at,
      uri: this.uri(e.vault_path),
    }));
  }
}
