import { afterEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import { makeApp, sha, upload, type TestApp } from "./helpers.js";

let t: TestApp;
afterEach(async () => {
  await t?.close();
});

async function smallChunks(t: TestApp, size = 256 * 1024) {
  await t.req("PATCH", "/api/settings", { upload: { smallChunk: size, mediumChunk: size * 2, largeChunk: size * 4, mediumThreshold: 4 * 1024 * 1024, largeThreshold: 16 * 1024 * 1024 } });
}

describe("settings", () => {
  it("PATCH changes only the sections sent and validates them", async () => {
    t = await makeApp({ startScheduler: false });
    await t.req("PATCH", "/api/settings", { gpu: { asrDevice: "GPU-aaa", diarDevice: "GPU-bbb" } });
    const r = await t.req("PATCH", "/api/settings", { obsidian: { vaultName: "EM's Brain" } });
    expect(r.status).toBe(200);
    expect(r.json.settings.gpu).toMatchObject({ asrDevice: "GPU-aaa", diarDevice: "GPU-bbb" });
    expect(r.json.settings.obsidian.vaultName).toBe("EM's Brain");
    expect((await t.req("PATCH", "/api/settings", { vad: { threshold: 5 } })).status).toBe(400);
    expect((await t.req("PATCH", "/api/settings", { nope: {} })).status).toBe(400);
    expect((await t.req("PATCH", "/api/settings", { obsidian: { allowedRoots: ["../x"] } })).status).toBe(400);
    expect((await t.req("GET", "/api/settings")).json.settings.gpu.asrDevice).toBe("GPU-aaa");
  });
});

describe("chunked upload", () => {
  it("requires login", async () => {
    t = await makeApp({ startScheduler: false, login: false });
    const r = await t.req("POST", "/api/uploads", { filename: "a.wav", size: 10 });
    expect(r.status).toBe(401);
  });

  it("uploads out of order in parallel, verifies, assembles by streaming and creates one job", async () => {
    t = await makeApp({ startScheduler: false });
    await smallChunks(t);
    const data = crypto.randomBytes(3 * 1024 * 1024 + 123);
    const r = await upload(t, data, "meeting.wav", { language: "zh", vocabulary: "ICT, 創創工坊" });
    expect(r.session.totalChunks).toBe(13);
    expect(r.sha256).toBe(sha(data));
    const rec = t.ctx.db.prepare("SELECT * FROM recordings WHERE id = ?").get(r.recordingId) as any;
    expect(fs.readFileSync(rec.source_path).equals(data)).toBe(true);
    expect(rec.language_hint).toBe("zh");
    const stages = t.ctx.db.prepare("SELECT name, status, progress_done FROM job_stages WHERE job_id = ? ORDER BY seq").all(r.jobId) as any[];
    expect(stages[0]).toMatchObject({ name: "upload", status: "completed", progress_done: data.length });
    // chunk directory is gone after assembly
    expect(fs.existsSync(`${t.dataDir}/uploads/${r.session.id}`)).toBe(false);
    // complete is idempotent
    const again = await t.req("POST", `/api/uploads/${r.session.id}/complete`, {});
    expect(again.json.recordingId).toBe(r.recordingId);
    expect((t.ctx.db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as any).n).toBe(1);
  });

  it("chunk size grows with file size and every request stays < 100 MB", async () => {
    t = await makeApp({ startScheduler: false });
    for (const [size, expected] of [
      [10 * 1024 ** 2, 8 * 1024 ** 2],
      [500 * 1024 ** 2, 16 * 1024 ** 2],
      [3 * 1024 ** 3, 32 * 1024 ** 2],
    ]) {
      const r = await t.req("POST", "/api/uploads", { filename: `f${size}.mp3`, size });
      expect(r.status).toBe(200);
      expect(r.json.chunkSize).toBe(expected);
      expect(r.json.chunkSize).toBeLessThan(100 * 1024 * 1024);
      expect(r.json.maxConcurrency).toBe(4);
    }
  });

  it("resumes: reports received chunks, re-sending is idempotent, corrupt chunks are rejected", async () => {
    t = await makeApp({ startScheduler: false });
    await smallChunks(t);
    const data = crypto.randomBytes(1024 * 1024 + 7);
    const c = (await t.req("POST", "/api/uploads", { filename: "x.m4a", size: data.length, fingerprint: "fp-1" })).json;
    const part = (i: number) => data.subarray(i * c.chunkSize, (i + 1) * c.chunkSize);
    await t.req("PUT", `/api/uploads/${c.id}/chunks/0`, part(0), { "x-chunk-sha256": sha(part(0)) });
    await t.req("PUT", `/api/uploads/${c.id}/chunks/2`, part(2), { "x-chunk-sha256": sha(part(2)) });
    // network retry of the same chunk
    const dup = await t.req("PUT", `/api/uploads/${c.id}/chunks/2`, part(2), { "x-chunk-sha256": sha(part(2)) });
    expect(dup.json.duplicate).toBe(true);
    // corrupted in transit
    const bad = await t.req("PUT", `/api/uploads/${c.id}/chunks/1`, part(1), { "x-chunk-sha256": sha(Buffer.from("other")) });
    expect(bad.status).toBe(422);
    // wrong size / out of range
    expect((await t.req("PUT", `/api/uploads/${c.id}/chunks/99`, part(1), { "x-chunk-sha256": sha(part(1)) })).status).toBe(400);
    // page refresh: same fingerprint hands back the same session with progress
    const resumed = (await t.req("POST", "/api/uploads", { filename: "x.m4a", size: data.length, fingerprint: "fp-1" })).json;
    expect(resumed.id).toBe(c.id);
    expect(resumed.resumed).toBe(true);
    expect(resumed.receivedChunks).toEqual([0, 2]);
    // completing with gaps fails and keeps the session usable
    const early = await t.req("POST", `/api/uploads/${c.id}/complete`, {});
    expect(early.status).toBe(409);
    expect(early.json.details.missing).toEqual([1, 3, 4]);
    for (const i of [1, 3, 4]) await t.req("PUT", `/api/uploads/${c.id}/chunks/${i}`, part(i), { "x-chunk-sha256": sha(part(i)) });
    const done = await t.req("POST", `/api/uploads/${c.id}/complete`, {});
    expect(done.status).toBe(200);
    expect(done.json.sha256).toBe(sha(data));
  });

  it("validates type, size and sanitises names (no path traversal)", async () => {
    t = await makeApp({ startScheduler: false });
    expect((await t.req("POST", "/api/uploads", { filename: "evil.exe", size: 10 })).status).toBe(415);
    expect((await t.req("POST", "/api/uploads", { filename: "a.wav", size: 10, mimeType: "text/html" })).status).toBe(415);
    expect((await t.req("POST", "/api/uploads", { filename: "a.wav", size: 1e13 })).status).toBe(413);
    const data = Buffer.from("RIFF....fake");
    const r = await upload(t, data, "../../../etc/passwd.wav");
    const rec = t.ctx.db.prepare("SELECT source_path FROM recordings WHERE id = ?").get(r.recordingId) as any;
    expect(rec.source_path.startsWith(`${t.dataDir}/recordings/${r.recordingId}/`)).toBe(true);
    expect(rec.source_path.endsWith("source.wav")).toBe(true);
    expect((await t.req("PUT", `/api/uploads/not-a-uuid/chunks/0`, data, { "x-chunk-sha256": sha(data) })).status).toBe(400);
  });

  it("refuses uploads when the disk would fill up", async () => {
    t = await makeApp({ startScheduler: false });
    await t.req("PATCH", "/api/settings", { storage: { minFreeBytes: Number.MAX_SAFE_INTEGER } });
    const r = await t.req("POST", "/api/uploads", { filename: "a.wav", size: 1000 });
    expect(r.status).toBe(507);
  });

  it("several files uploaded at the same time never overwrite each other", async () => {
    t = await makeApp({ startScheduler: false });
    await smallChunks(t);
    const files = [0, 1, 2, 3].map((i) => crypto.randomBytes(600 * 1024 + i));
    const results = await Promise.all(files.map((d, i) => upload(t, d, `same-name.wav`, {}, { fingerprint: `fp-${i}` })));
    const ids = new Set(results.map((r) => r.recordingId));
    expect(ids.size).toBe(4);
    for (const [i, r] of results.entries()) {
      const rec = t.ctx.db.prepare("SELECT source_path, sha256 FROM recordings WHERE id = ?").get(r.recordingId) as any;
      expect(rec.sha256).toBe(sha(files[i]));
      expect(fs.readFileSync(rec.source_path).equals(files[i])).toBe(true);
    }
    expect((t.ctx.db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as any).n).toBe(4);
  });
});
