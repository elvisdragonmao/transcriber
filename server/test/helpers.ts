import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { buildApp, type BuildOptions, type BuiltApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { MockWorkerPool } from "../src/workers/mock.js";
import type { LlmAdapter, GenerateArgs } from "../src/llm/adapters.js";

export function tmpDir(prefix = "transcriber-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export interface TestApp extends BuiltApp {
  cookie: string;
  dataDir: string;
  workers: MockWorkerPool;
  req: (method: string, url: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; json: any; body: string; headers: any }>;
}

export async function makeApp(opts: BuildOptions & { dataDir?: string; login?: boolean } = {}): Promise<TestApp> {
  const dataDir = opts.dataDir ?? tmpDir();
  const config = loadConfig({ dataDir, adminPassword: "test-password-123", mockWorker: true, secureCookies: false, claudeBin: "/nonexistent/claude", codexBin: "/nonexistent/codex" });
  const workers = (opts.workers as MockWorkerPool) ?? new MockWorkerPool();
  const built = await buildApp(config, { logger: false, ...opts, workers });
  let cookie = "";
  const req: TestApp["req"] = async (method, url, body, headers = {}) => {
    const isBuf = Buffer.isBuffer(body);
    const res = await built.app.inject({
      method: method as any,
      url,
      payload: body === undefined ? undefined : isBuf ? (body as Buffer) : JSON.stringify(body),
      headers: { ...(body !== undefined ? { "content-type": isBuf ? "application/octet-stream" : "application/json" } : {}), cookie, ...headers },
    });
    let j: any = null;
    try {
      j = res.json();
    } catch {
      /* not json */
    }
    return { status: res.statusCode, json: j, body: res.body, headers: res.headers };
  };
  if (opts.login !== false) {
    const r = await built.app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "test-password-123" } });
    cookie = String(r.headers["set-cookie"]).split(";")[0];
  }
  return { ...built, cookie, dataDir, workers, req };
}

export const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** A real (tiny) audio file made by ffmpeg so the prepare stage exercises real decoding. */
export function makeWav(seconds = 20, file?: string): Buffer {
  const out = file ?? path.join(tmpDir("wav-"), "a.wav");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=330:duration=${seconds}`, "-ac", "1", "-ar", "16000", out]);
  return fs.readFileSync(out);
}

export async function upload(t: TestApp, data: Buffer, filename: string, options: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const c = await t.req("POST", "/api/uploads", { filename, size: data.length, mimeType: "", fingerprint: `${filename}:${data.length}`, options, ...extra });
  if (c.status !== 200) throw new Error(`create failed ${c.status} ${c.body}`);
  const s = c.json;
  const order = [...Array(s.totalChunks).keys()].reverse(); // out of order on purpose
  await Promise.all(
    order.map(async (i) => {
      const part = data.subarray(i * s.chunkSize, Math.min(data.length, (i + 1) * s.chunkSize));
      const r = await t.req("PUT", `/api/uploads/${s.id}/chunks/${i}`, part, { "x-chunk-sha256": sha(part) });
      if (r.status !== 200) throw new Error(`chunk ${i} failed ${r.status} ${r.body}`);
    }),
  );
  const done = await t.req("POST", `/api/uploads/${s.id}/complete`, {});
  if (done.status !== 200) throw new Error(`complete failed ${done.status} ${done.body}`);
  return { session: s, ...done.json };
}

export async function waitFor<T>(fn: () => T | Promise<T>, pred: (v: T) => boolean, timeoutMs = 20000, stepMs = 50): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (pred(v)) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting; last value: ${JSON.stringify(v).slice(0, 800)}`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

export async function waitJob(t: TestApp, jobId: string, statuses: string[], timeoutMs = 20000) {
  return waitFor(
    async () => (await t.req("GET", `/api/jobs/${jobId}`)).json,
    (j) => statuses.includes(j?.status),
    timeoutMs,
  );
}

export class FakeLlm implements LlmAdapter {
  calls: GenerateArgs[] = [];
  constructor(
    readonly id: "claude" | "codex",
    public respond: (a: GenerateArgs) => any,
  ) {}
  async status() {
    return { provider: this.id, installed: true, version: "fake", loggedIn: true, account: "test", detail: "fake", efforts: ["low", "medium", "high"] };
  }
  async generate(a: GenerateArgs) {
    this.calls.push(a);
    return { output: this.respond(a), costUsd: 0.01, durationMs: 5, resolvedModel: "fake-model" };
  }
}

export function meetingOutput(classification: Record<string, unknown>) {
  return {
    title: "專案討論會議",
    date: null,
    participants: [],
    executive_summary: "討論了測試內容。",
    topics: [{ title: "測試", summary: "內容 <script>alert(1)</script>", timestamps: ["00:00:01"] }],
    decisions: [],
    action_items: [{ task: "寫測試", owner: null, deadline: null, timestamp: "00:00:05" }],
    open_questions: [],
    key_timestamps: [],
    uncertain: [],
    classification: {
      document_type: "meeting",
      detected_project: null,
      suggested_folder: null,
      new_folder_name: null,
      suggested_title: "專案討論會議",
      classification_confidence: 0.2,
      classification_reason: "test",
      evidence: [],
      ...classification,
    },
  };
}
