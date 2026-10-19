#!/usr/bin/env node
// Real-model acceptance run through the public HTTP API (same calls as the browser).
//   node scripts/acceptance.mjs --file a.m4a [--language auto|zh|en] [--template none|meeting|class] [--title T] [--vocab "a,b"]
// Env: BASE (default http://127.0.0.1:8000), ADMIN_USER, ADMIN_PASSWORD (read from .env when absent).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const env = Object.fromEntries(
  fs.existsSync(path.join(root, ".env"))
    ? fs.readFileSync(path.join(root, ".env"), "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
    : [],
);
const BASE = process.env.BASE ?? `http://127.0.0.1:${env.PORT ?? 8000}`;
let cookie = "";
const out = { file: args.file, startedAt: new Date().toISOString(), checks: [] };
const check = (name, ok, detail) => {
  out.checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

async function api(method, url, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const res = await fetch(BASE + url, {
    method,
    headers: { cookie, origin: BASE, ...(body !== undefined ? { "content-type": isBuf ? "application/octet-stream" : "application/json" } : {}), ...headers },
    body: body === undefined ? undefined : isBuf ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let j = null;
  try {
    j = JSON.parse(text);
  } catch {}
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${text.slice(0, 300)}`);
  const sc = res.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0];
  return j ?? text;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await api("POST", "/api/auth/login", { username: process.env.ADMIN_USER ?? env.ADMIN_USER ?? "admin", password: process.env.ADMIN_PASSWORD ?? env.ADMIN_PASSWORD });

// ---- chunked upload ----
const data = fs.readFileSync(args.file);
const t0 = Date.now();
const s = await api("POST", "/api/uploads", {
  filename: path.basename(args.file),
  size: data.length,
  fingerprint: `${path.basename(args.file)}:${data.length}:acceptance:${Date.now()}`,
  options: { language: args.language ?? "auto", noteTemplate: args.template ?? "none", title: args.title, vocabulary: args.vocab ?? "" },
});
const idx = [...Array(s.totalChunks).keys()];
await Promise.all(
  Array.from({ length: s.maxConcurrency }, async () => {
    while (idx.length) {
      const i = idx.shift();
      const part = data.subarray(i * s.chunkSize, Math.min(data.length, (i + 1) * s.chunkSize));
      await api("PUT", `/api/uploads/${s.id}/chunks/${i}`, part, { "x-chunk-sha256": crypto.createHash("sha256").update(part).digest("hex") });
    }
  }),
);
const done = await api("POST", `/api/uploads/${s.id}/complete`, {});
check("upload assembled and verified", done.sha256 === crypto.createHash("sha256").update(data).digest("hex"), `${s.totalChunks} chunks of ${s.chunkSize} B, ${((Date.now() - t0) / 1000).toFixed(1)} s`);

// ---- follow the job ----
const samples = [];
let job;
let last = "";
for (;;) {
  job = await api("GET", `/api/jobs/${done.jobId}`);
  samples.push({ t: Date.now(), p: job.progress, stages: Object.fromEntries(job.stages.map((x) => [x.name, x.progress])) });
  const running = job.stages.filter((x) => x.status === "running").map((x) => `${x.name} ${x.progress == null ? "…" : Math.round(x.progress * 100) + "%"}${x.etaSeconds != null ? ` eta ${Math.round(x.etaSeconds)}s` : ""}`);
  const line = `${(job.progress * 100).toFixed(1)}% ${job.status} ${running.join(", ")}`;
  if (line !== last) console.log("   ", line);
  last = line;
  if (["completed", "failed", "cancelled"].includes(job.status)) break;
  await sleep(1500);
}
check("job completed", job.status === "completed", job.error ?? undefined);
const mono = samples.every((x, i) => i === 0 || x.p >= samples[i - 1].p - 1e-9);
check("overall progress never goes backwards", mono, `${samples.length} samples`);
const stageTimes = Object.fromEntries(job.stages.filter((x) => x.startedAt && x.endedAt).map((x) => [x.name, +((Date.parse(x.endedAt) - Date.parse(x.startedAt)) / 1000).toFixed(1)]));
out.stageSeconds = stageTimes;
out.stageModels = Object.fromEntries(job.stages.filter((x) => x.modelVersion).map((x) => [x.name, x.modelVersion]));
out.stageDetails = Object.fromEntries(job.stages.filter((x) => x.detail).map((x) => [x.name, x.detail]));
out.jobEvents = job.events.slice(0, 40).map((e) => `${e.level} ${e.stage ?? "-"} ${e.message}`);
console.log("stage seconds:", stageTimes);

// ---- transcript checks ----
const rec = await api("GET", `/api/recordings/${done.recordingId}`);
const tr = await api("GET", `/api/recordings/${done.recordingId}/transcript?words=1`);
const words = tr.segments.flatMap((x) => x.words ?? []);
const aligned = words.filter((w) => w.a);
check("transcript has segments", tr.segments.length > 0, `${tr.segments.length} segments, ${words.length} words, language ${tr.language}`);
check("forced alignment produced word timestamps", aligned.length > words.length * 0.9 && aligned.every((w) => w.e >= w.s && w.s >= 0 && w.e <= (rec.durationMs ?? Infinity) + 50), `${aligned.length}/${words.length} aligned`);
const ordered = tr.segments.every((x, i) => i === 0 || x.start >= tr.segments[i - 1].start);
check("segments time-ordered on the original timeline", ordered);
const st = { assigned: 0, overlap: 0, uncertain: 0, manual: 0 };
for (const x of tr.segments) st[x.status]++;
check("speaker labels assigned", tr.speakers.length > 0 && st.assigned > 0, `${tr.speakers.length} speakers; ${JSON.stringify(st)}`);
out.speakers = tr.speakers.map((x) => ({ label: x.label, name: x.name, assignment: x.assignment, score: x.matchScore, speechS: Math.round(x.speechMs / 1000), cleanS: Math.round(x.cleanSpeechMs / 1000) }));
out.recording = { id: rec.id, title: rec.title, durationMs: rec.durationMs, languages: tr.languages };
out.sample = tr.segments.slice(0, 12).map((x) => `[${new Date(x.start).toISOString().slice(11, 19)}] ${tr.speakers.find((p) => p.id === x.speakerId)?.name ?? "?"} (${x.status}): ${x.text}`);
for (const l of out.sample) console.log("   ", l);
for (const f of ["txt", "md", "json", "srt", "vtt"]) {
  const body = await api("GET", `/api/recordings/${done.recordingId}/export?format=${f}`);
  check(`export ${f}`, (typeof body === "string" ? body : JSON.stringify(body)).length > 50);
}
const exps = await api("GET", `/api/recordings/${done.recordingId}/exports`);
out.obsidian = exps.items.map((e) => ({ kind: e.kind, path: e.path, status: e.status, suggested: e.suggestedPath }));
if (exps.items.length) check("saved to Obsidian", exps.items.some((e) => e.status === "written"), exps.items.map((e) => `${e.kind}: ${e.path} [${e.status}]`).join("; "));
if ((args.template ?? "none") !== "none") {
  const notes = await api("GET", `/api/recordings/${done.recordingId}/notes`);
  check("AI notes generated", notes.items.length > 0, notes.items[0] ? `${notes.items[0].provider}:${notes.items[0].model}, ${notes.items[0].markdown.length} chars` : "");
  out.noteClassification = notes.items[0]?.classification?.classification;
}
out.finishedAt = new Date().toISOString();
const report = path.join(root, "data", "acceptance", `${path.basename(args.file)}-${Date.now()}.json`);
fs.mkdirSync(path.dirname(report), { recursive: true });
fs.writeFileSync(report, JSON.stringify(out, null, 2));
console.log("report:", report);
process.exit(out.checks.every((c) => c.ok) ? 0 : 1);
