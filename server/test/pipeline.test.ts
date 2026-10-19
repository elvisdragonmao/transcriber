import { afterEach, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import { makeApp, makeWav, upload, waitFor, waitJob, type TestApp } from "./helpers.js";
import { MockWorkerPool } from "../src/workers/mock.js";

let t: TestApp | null = null;
let wav: Buffer;
beforeAll(() => {
  wav = makeWav(60);
});
afterEach(async () => {
  await t?.close();
  t = null;
});

describe("transcription pipeline (mock worker, real ffmpeg)", () => {
  it("runs every stage with real progress and produces a transcript with speakers", async () => {
    t = await makeApp();
    const r = await upload(t, wav, "standup.wav");
    const job = await waitJob(t, r.jobId, ["completed", "failed"]);
    expect(job.status).toBe("completed");
    expect(job.progress).toBe(1);
    for (const s of job.stages) expect(["completed", "skipped"]).toContain(s.status);
    expect(job.stages.find((s: any) => s.name === "notes").status).toBe("skipped");
    const prep = job.stages.find((s: any) => s.name === "prepare");
    expect(prep.unit).toBe("ms");
    expect(prep.done).toBe(prep.total);

    const rec = (await t.req("GET", `/api/recordings/${r.recordingId}`)).json;
    expect(rec.durationMs).toBeGreaterThan(59000);
    const tr = (await t.req("GET", `/api/recordings/${r.recordingId}/transcript?words=1`)).json;
    expect(tr.status).toBe("complete");
    expect(tr.segments.length).toBeGreaterThan(5);
    expect(tr.speakers.length).toBe(2);
    // segments are time ordered and words sit inside their segment
    for (let i = 1; i < tr.segments.length; i++) expect(tr.segments[i].start).toBeGreaterThanOrEqual(tr.segments[i - 1].start);
    for (const s of tr.segments) for (const w of s.words) expect(w.s >= s.start - 1 && w.e <= s.end + 1).toBe(true);
    // a waveform was computed
    const peaks = (await t.req("GET", `/api/recordings/${r.recordingId}/peaks`)).json;
    expect(peaks.peaks.length).toBeGreaterThan(100);

    for (const f of ["txt", "md", "json", "srt", "vtt"]) {
      const e = await t.req("GET", `/api/recordings/${r.recordingId}/export?format=${f}`);
      expect(e.status).toBe(200);
      expect(e.body.length).toBeGreaterThan(20);
    }
    const srt = (await t.req("GET", `/api/recordings/${r.recordingId}/export?format=srt`)).body;
    expect(srt).toMatch(/^1\n00:00:0\d,\d{3} --> 00:00:\d\d,\d{3}\n/);
    expect((await t.req("GET", `/api/recordings/${r.recordingId}/export?format=vtt`)).body.startsWith("WEBVTT")).toBe(true);
  });

  it("pauses at a segment boundary, keeps finished work, and resumes without redoing it", async () => {
    const workers = new MockWorkerPool();
    workers.stepMs = 60;
    workers.durationMs = 600_000; // 60 ASR segments
    t = await makeApp({ workers });
    const r = await upload(t, wav, "long.wav");
    await waitFor(
      async () => (await t!.req("GET", `/api/jobs/${r.jobId}`)).json,
      (j) => j.stages.find((s: any) => s.name === "asr").status === "running" && (j.stages.find((s: any) => s.name === "asr").done ?? 0) >= 5,
    );
    expect((await t.req("POST", `/api/jobs/${r.jobId}/pause`)).status).toBe(200);
    const paused = await waitJob(t, r.jobId, ["paused"]);
    const asr = paused.stages.find((s: any) => s.name === "asr");
    expect(asr.status).toBe("pending");
    const doneBefore = asr.done;
    expect(doneBefore).toBeGreaterThanOrEqual(5);
    expect(doneBefore).toBeLessThan(60);
    // a paused job does not progress
    await new Promise((res) => setTimeout(res, 400));
    expect((await t.req("GET", `/api/jobs/${r.jobId}`)).json.stages.find((s: any) => s.name === "asr").done).toBe(doneBefore);
    const ck = JSON.parse(fs.readFileSync(`${t.dataDir}/recordings/${r.recordingId}/work/asr.ckpt.json`, "utf8"));
    expect(Object.keys(ck.items).length).toBe(doneBefore);

    workers.stepMs = 2;
    await t.req("POST", `/api/jobs/${r.jobId}/resume`);
    const done = await waitJob(t, r.jobId, ["completed", "failed"], 60000);
    expect(done.status).toBe("completed");
    // ASR was called exactly twice (before and after the pause), checkpointed segments were reused
    expect(workers.calls.filter((c) => c.op === "asr").length).toBe(2);
  });

  it("cancels a running job and stops its workers", async () => {
    const workers = new MockWorkerPool();
    workers.stepMs = 80;
    workers.durationMs = 600_000;
    t = await makeApp({ workers });
    const r = await upload(t, wav, "cancel.wav");
    await waitFor(async () => (await t!.req("GET", `/api/jobs/${r.jobId}`)).json, (j) => j.stages.find((s: any) => s.name === "asr").status === "running");
    await t.req("POST", `/api/jobs/${r.jobId}/cancel`, { keepPartial: false });
    const j = await waitJob(t, r.jobId, ["cancelled"]);
    expect(j.stages.every((s: any) => ["completed", "skipped", "cancelled"].includes(s.status))).toBe(true);
    expect(fs.existsSync(`${t.dataDir}/recordings/${r.recordingId}/work`)).toBe(false);
    // retry after cancel works
    workers.stepMs = 1;
    await t.req("POST", `/api/jobs/${r.jobId}/retry`);
    expect((await waitJob(t, r.jobId, ["completed", "failed"], 60000)).status).toBe("completed");
  });

  it("recovers jobs after a server restart (nothing stays stuck in running)", async () => {
    const workers = new MockWorkerPool();
    workers.stepMs = 50;
    workers.durationMs = 300_000;
    t = await makeApp({ workers });
    const dataDir = t.dataDir;
    const r = await upload(t, wav, "crash.wav");
    await waitFor(async () => (await t!.req("GET", `/api/jobs/${r.jobId}`)).json, (j) => (j.stages.find((s: any) => s.name === "asr").done ?? 0) >= 3);
    // simulate a crash: the DB says "running", the process is gone
    t.ctx.db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(r.jobId);
    await t.scheduler.stop();
    t.ctx.db.prepare("UPDATE job_stages SET status = 'running', lease_owner = 'dead-instance' WHERE job_id = ? AND name = 'asr'").run(r.jobId);
    await t.close();
    t = await makeApp({ dataDir, workers: Object.assign(new MockWorkerPool(), { stepMs: 1, durationMs: 300_000 }) });
    const ev = (await t.req("GET", `/api/jobs/${r.jobId}`)).json.events;
    expect(ev.some((e: any) => e.type === "recovered")).toBe(true);
    const done = await waitJob(t, r.jobId, ["completed", "failed"], 60000);
    expect(done.status).toBe("completed");
  });

  it("retries a GPU OOM automatically and records the retry", async () => {
    const workers = new MockWorkerPool();
    workers.failures.push({ op: "asr", code: "OOM", times: 1, retryable: true });
    t = await makeApp({ workers });
    t.ctx.db.exec("UPDATE job_stages SET next_attempt_at = NULL"); // no-op, jobs are created later
    const r = await upload(t, wav, "oom.wav");
    // skip the backoff delay
    const timer = setInterval(() => {
      t?.ctx.db.prepare("UPDATE job_stages SET next_attempt_at = NULL WHERE job_id = ?").run(r.jobId);
      t?.scheduler.kick();
    }, 100);
    const done = await waitJob(t, r.jobId, ["completed", "failed"], 60000);
    clearInterval(timer);
    expect(done.status).toBe("completed");
    const asr = done.stages.find((s: any) => s.name === "asr");
    expect(asr.retryCount).toBe(1);
    expect(done.events.some((e: any) => e.type === "stage_retry")).toBe(true);
  });

  it("fails clearly on unreadable audio and does not retry it", async () => {
    t = await makeApp();
    const r = await upload(t, Buffer.from("this is not audio at all, just text pretending"), "broken.mp3");
    const j = await waitJob(t, r.jobId, ["failed"]);
    const prep = j.stages.find((s: any) => s.name === "prepare");
    expect(prep.status).toBe("failed");
    expect(prep.errorCode).toBe("BAD_INPUT");
    expect(prep.retryCount).toBe(0);
    expect(j.error).toMatch(/prepare/);
  });

  it("GPU lanes run one heavy stage at a time across many jobs", async () => {
    const workers = new MockWorkerPool();
    workers.stepMs = 15;
    const active = new Map<string, number>();
    let maxAsr = 0;
    const orig = workers.call.bind(workers);
    workers.call = async (lane, op, p, o) => {
      active.set(lane, (active.get(lane) ?? 0) + 1);
      if (lane === "gpu-asr") maxAsr = Math.max(maxAsr, active.get(lane)!);
      try {
        return await orig(lane, op, p, o);
      } finally {
        active.set(lane, active.get(lane)! - 1);
      }
    };
    t = await makeApp({ workers });
    const rs = await Promise.all([0, 1, 2].map((i) => upload(t!, wav, `m${i}.wav`, {}, { fingerprint: `m${i}` })));
    for (const r of rs) expect((await waitJob(t, r.jobId, ["completed", "failed"], 60000)).status).toBe("completed");
    expect(maxAsr).toBe(1);
  });
});
