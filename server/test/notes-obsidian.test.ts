import { afterEach, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { FakeLlm, makeApp, makeWav, meetingOutput, tmpDir, upload, waitJob, type TestApp } from "./helpers.js";
import { FsVaultBackend } from "../src/obsidian/backends.js";
import { TRANS_ROOT } from "../src/settings.js";

let t: TestApp | null = null;
let wav: Buffer;
let vault: string;
beforeAll(() => {
  wav = makeWav(30);
});
afterEach(async () => {
  await t?.close();
  t = null;
});

function makeVault() {
  vault = tmpDir("vault-");
  fs.mkdirSync(path.join(vault, ".obsidian"));
  fs.mkdirSync(path.join(vault, TRANS_ROOT, "逐字稿"), { recursive: true });
  fs.mkdirSync(path.join(vault, TRANS_ROOT, "ICT 創創工坊"), { recursive: true });
  fs.writeFileSync(path.join(vault, TRANS_ROOT, "ICT 創創工坊", "261001 啟動會議 會議記錄.md"), "# 啟動會議\n");
  fs.mkdirSync(path.join(vault, "Projects", "Secret"), { recursive: true });
  fs.writeFileSync(path.join(vault, "Projects", "Secret", "keep.md"), "do not touch\n");
  return vault;
}

async function appWith(llm: FakeLlm) {
  makeVault();
  const a = await makeApp({ llmAdapters: { claude: llm } });
  await a.req("PATCH", "/api/settings", { obsidian: { backend: "filesystem", vaultRoot: vault, vaultName: "My Vault", autoExport: true } });
  return a;
}

const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));

describe("notes + Obsidian filing", () => {
  it("generates meeting minutes, files them into the matching project and links transcript ⇄ note", async () => {
    const llm = new FakeLlm("claude", (a) => {
      expect(a.prompt).toContain(`${TRANS_ROOT}/ICT 創創工坊`);
      expect(a.prompt).toContain("<transcript>");
      return meetingOutput({ suggested_folder: `${TRANS_ROOT}/ICT 創創工坊`, classification_confidence: 0.92, detected_project: "ICT 創創工坊" });
    });
    t = await appWith(llm);
    const r = await upload(t, wav, "New Recording 8.wav", { noteTemplate: "meeting" }, { lastModified: Date.parse("2026-10-19T03:00:00Z") });
    const j = await waitJob(t, r.jobId, ["completed", "failed"], 60000);
    expect(j.status).toBe("completed");
    expect(llm.calls[0].system).toMatch(/untrusted DATA/);

    const note = path.join(vault, TRANS_ROOT, "ICT 創創工坊", "261019 專案討論會議 會議記錄.md");
    const transcript = path.join(vault, TRANS_ROOT, "逐字稿", "261019 專案討論會議 逐字稿.md");
    expect(fs.existsSync(note)).toBe(true);
    expect(fs.existsSync(transcript)).toBe(true);
    const n = fs.readFileSync(note, "utf8");
    expect(n).toContain("原始逐字稿：[[261019 專案討論會議 逐字稿]]");
    expect(n).not.toContain("<script>");
    expect(n).toMatch(/^---\ntitle: "專案討論會議"/);
    const tr = fs.readFileSync(transcript, "utf8");
    expect(tr).toContain("[[261019 專案討論會議 會議記錄]]");
    expect(tr).toMatch(/transcript_id: "[0-9a-f-]{36}"/);
    // AI title replaced the filename-derived one
    expect((await t.req("GET", `/api/recordings/${r.recordingId}`)).json.title).toBe("專案討論會議");
    const exps = (await t.req("GET", `/api/recordings/${r.recordingId}/exports`)).json.items;
    expect(exps.find((e: any) => e.kind === "note").uri).toBe(
      `obsidian://open?vault=My%20Vault&file=${encodeURIComponent(`${TRANS_ROOT}/ICT 創創工坊/261019 專案討論會議 會議記錄`)}`,
    );
  });

  it("uncertain or hostile classification never writes outside the authorised folder", async () => {
    const llm = new FakeLlm("claude", () =>
      meetingOutput({ suggested_folder: "../../../etc", new_folder_name: "../../evil", classification_confidence: 0.99, detected_project: "Secret" }),
    );
    t = await appWith(llm);
    const before = walk(path.join(vault, "Projects")).map((f) => [f, fs.readFileSync(f, "utf8")]);
    const r = await upload(t, wav, "talk.wav", { noteTemplate: "meeting" });
    const j = await waitJob(t, r.jobId, ["completed", "failed"], 60000);
    expect(j.status).toBe("completed");
    const files = walk(vault).filter((f) => !f.includes(".obsidian"));
    for (const f of files) {
      const rel = path.relative(vault, f);
      expect(rel.startsWith(TRANS_ROOT + "/") || rel.startsWith("Projects/")).toBe(true);
    }
    expect(walk(path.join(vault, "Projects")).map((f) => [f, fs.readFileSync(f, "utf8")])).toEqual(before);
    const pending = walk(path.join(vault, TRANS_ROOT, "待整理"));
    expect(pending.length).toBe(1);
    const exp = (await t.req("GET", `/api/recordings/${r.recordingId}/exports`)).json.items.find((e: any) => e.kind === "note");
    expect(exp.status).toBe("pending_review");
    // the sanitised new-folder suggestion stays inside the transcripts root
    expect(exp.suggestedPath.startsWith(`${TRANS_ROOT}/`)).toBe(true);
    // moving to a folder outside the allowed roots is refused
    const bad = await t.req("POST", `/api/notes/${exp.noteId}/obsidian`, { folder: "Projects/Secret" });
    expect(bad.status).toBe(400);
    const bad2 = await t.req("POST", `/api/notes/${exp.noteId}/obsidian`, { folder: `${TRANS_ROOT}/../Projects` });
    expect(bad2.status).toBe(400);
    // moving inside is fine and removes the pending copy
    const ok = await t.req("POST", `/api/notes/${exp.noteId}/obsidian`, { folder: `${TRANS_ROOT}/新專案` });
    expect(ok.status).toBe(200);
    expect(fs.existsSync(path.join(vault, ok.json.path))).toBe(true);
    expect(walk(path.join(vault, TRANS_ROOT, "待整理")).length).toBe(0);
  });

  it("never silently overwrites a note the user edited; writes a new version instead", async () => {
    const llm = new FakeLlm("claude", () => meetingOutput({ suggested_folder: `${TRANS_ROOT}/ICT 創創工坊`, classification_confidence: 0.9 }));
    t = await appWith(llm);
    const r = await upload(t, wav, "rerun.wav", { noteTemplate: "meeting", title: "週會" }, { lastModified: Date.parse("2026-10-19T03:00:00Z") });
    await waitJob(t, r.jobId, ["completed"], 60000);
    const note = path.join(vault, TRANS_ROOT, "ICT 創創工坊", "261019 週會 會議記錄.md");
    fs.appendFileSync(note, "\n我手動加的內容\n");
    // regenerate notes after the transcription finished → separate notes job, transcription job stays 100%
    const g = await t.req("POST", `/api/recordings/${r.recordingId}/notes`, { template: "meeting" });
    expect(g.status).toBe(200);
    const nj = await waitJob(t, g.json.jobId, ["completed", "failed"], 60000);
    expect(nj.status).toBe("completed");
    expect((await t.req("GET", `/api/jobs/${r.jobId}`)).json.progress).toBe(1);
    expect(fs.readFileSync(note, "utf8")).toContain("我手動加的內容");
    expect(fs.existsSync(path.join(vault, TRANS_ROOT, "ICT 創創工坊", "261019 週會 會議記錄 v2.md"))).toBe(true);
  });

  it("deleting audio keeps the transcript; deleting a recording keeps Obsidian files unless confirmed", async () => {
    const llm = new FakeLlm("claude", () => meetingOutput({}));
    t = await appWith(llm);
    const r = await upload(t, wav, "del.wav", { title: "刪除測試" });
    await waitJob(t, r.jobId, ["completed"], 60000);
    const rec = t.ctx.db.prepare("SELECT source_path, audio_path FROM recordings WHERE id = ?").get(r.recordingId) as any;
    expect((await t.req("DELETE", `/api/recordings/${r.recordingId}/audio`)).status).toBe(200);
    expect(fs.existsSync(rec.source_path)).toBe(false);
    expect(fs.existsSync(rec.audio_path)).toBe(false);
    const tr = await t.req("GET", `/api/recordings/${r.recordingId}/transcript`);
    expect(tr.status).toBe(200);
    expect(tr.json.segments.length).toBeGreaterThan(0);
    expect((await t.req("GET", `/api/recordings/${r.recordingId}/audio`)).status).toBe(404);

    const vaultFiles = walk(path.join(vault, TRANS_ROOT, "逐字稿"));
    expect(vaultFiles.length).toBe(1);
    expect((await t.req("DELETE", `/api/recordings/${r.recordingId}`, { deleteObsidianFiles: true })).status).toBe(400); // needs explicit confirm
    expect((await t.req("DELETE", `/api/recordings/${r.recordingId}`, {})).status).toBe(200);
    expect(walk(path.join(vault, TRANS_ROOT, "逐字稿"))).toEqual(vaultFiles);
    expect(fs.existsSync(`${t.dataDir}/recordings/${r.recordingId}`)).toBe(false);
  });

  it("speaker rename persists and enrolls a voiceprint used by later recordings", async () => {
    t = await appWith(new FakeLlm("claude", () => meetingOutput({})));
    await t.req("PATCH", "/api/settings", { identify: { minTotalCleanSec: 1 } });
    const r1 = await upload(t, wav, "a.wav", {}, { fingerprint: "a" });
    await waitJob(t, r1.jobId, ["completed"], 60000);
    const tr = (await t.req("GET", `/api/recordings/${r1.recordingId}/transcript`)).json;
    const s0 = tr.speakers.find((s: any) => s.diarIndex === 0);
    const p = await t.req("PATCH", `/api/recording-speakers/${s0.id}`, { newName: "王小明", enroll: true });
    expect(p.status).toBe(200);
    const after = (await t.req("GET", `/api/recordings/${r1.recordingId}/transcript`)).json;
    expect(after.speakers.find((s: any) => s.id === s0.id).name).toBe("王小明");
    const speakers = (await t.req("GET", "/api/speakers")).json.items;
    expect(speakers[0]).toMatchObject({ name: "王小明", embeddings: 1 });
    // second recording: mock embeddings are identical per diar index → auto match
    const r2 = await upload(t, wav, "b.wav", {}, { fingerprint: "b" });
    await waitJob(t, r2.jobId, ["completed"], 60000);
    const tr2 = (await t.req("GET", `/api/recordings/${r2.recordingId}/transcript`)).json;
    const m = tr2.speakers.find((s: any) => s.diarIndex === 0);
    expect(m).toMatchObject({ name: "王小明", assignment: "auto" });
    expect(tr2.speakers.find((s: any) => s.diarIndex === 1).assignment).not.toBe("auto");
    // manual text edit keeps the original
    const seg = tr2.segments[0];
    await t.req("PATCH", `/api/segments/${seg.id}`, { text: "修正後的文字" });
    const tr3 = (await t.req("GET", `/api/recordings/${r2.recordingId}/transcript`)).json;
    expect(tr3.segments[0]).toMatchObject({ text: "修正後的文字", textOriginal: seg.textOriginal, edited: true });
  });

  it("reports an unconfigured / missing CLI clearly", async () => {
    t = await makeApp();
    const s = (await t.req("GET", "/api/llm/status")).json;
    const codex = s.providers.find((p: any) => p.provider === "codex");
    expect(codex.installed).toBe(false);
    expect(codex.detail).toMatch(/not found/);
    const st = (await t.req("GET", "/api/obsidian/status")).json;
    expect(st.configured).toBe(false);
  });
});
