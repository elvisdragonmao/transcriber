/**
 * Demo instance with fictional data, used to take the README screenshots.
 * No models, no GPUs, no real recordings: a scripted worker returns made-up transcripts
 * and a fake LLM returns made-up notes.
 *
 *   cd server && npx tsx ../scripts/demo/server.mts [port]     # login: demo / demo-password
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { buildApp } from "../../server/src/app.js";
import { loadConfig } from "../../server/src/config.js";
import { writeFileAtomic, sleep } from "../../server/src/lib/util.js";
import { StageSignal, WorkerCallError, type CallOptions, type Lane, type WorkerPoolLike } from "../../server/src/workers/pool.js";
import type { GenerateArgs, LlmAdapter } from "../../server/src/llm/adapters.js";

type Line = [speaker: number, text: string];

// ---- fictional scripts -----------------------------------------------------------
const SCRIPTS: Record<string, { speakers: string[]; lines: Line[] }> = {
  meeting: {
    speakers: ["林佳穎", "陳志豪", "Alex Chen"],
    lines: [
      [0, "好，我們開始今天的產品週會，主要是確認下週二上線前的檢查清單。"],
      [1, "後端這邊 API 都已經部署到 staging，load test 跑過了，p95 大概在 180 毫秒。"],
      [0, "那 rate limit 的部分有調整嗎？上次說要從每分鐘六十次改成一百二十次。"],
      [1, "有，已經改了，不過我想先觀察一週再決定要不要開放給所有方案。"],
      [2, "設計這邊的 onboarding flow 改完了，新版的空狀態插圖也放上去了。"],
      [2, "I'd like to run a quick usability test on Thursday before we ship."],
      [0, "可以，Alex 你週四跟兩位使用者約時間，我來準備測試腳本。"],
      [1, "另外 Sentry 有幾個 null pointer 的錯誤，我週三前會修掉。"],
      [0, "好，那決議是：週二照原定時間上線，rate limit 先維持一百二十次。"],
      [2, "還有一個問題，深色模式的對比度在部分頁面還不夠，要不要這版一起處理？"],
      [1, "這個我覺得可以下一版再做，風險比較小。"],
      [0, "同意，先開 ticket 追蹤。最後確認一下，release note 由我來寫。"],
      [2, "Sounds good. 我會把截圖整理好給你。"],
      [0, "那今天就到這裡，謝謝大家。"],
    ],
  },
  class: {
    speakers: ["王教授", "學生"],
    lines: [
      [0, "今天我們要講 gradient descent，也就是梯度下降法。"],
      [0, "想像你站在山上，眼睛被蒙起來，只能感覺腳下的坡度，要怎麼走到山谷？"],
      [0, "答案就是每一步都往最陡的下坡方向走，這個方向就是負的 gradient。"],
      [0, "learning rate 決定每一步走多大，太大會震盪甚至發散，太小會收斂得很慢。"],
      [1, "老師，那要怎麼選 learning rate？"],
      [0, "好問題，實務上常用 learning rate schedule，或是 Adam 這類 adaptive 的方法。"],
      [0, "這部分期中考一定會考，大家要記得畫出 loss 曲線的三種情況。"],
      [0, "下週我們會講 stochastic gradient descent，請先讀課本第四章。"],
    ],
  },
  interview: {
    speakers: ["林佳穎", "受訪者"],
    lines: [
      [0, "謝謝你今天來，先請你簡單介紹一下平常怎麼記錄會議？"],
      [1, "我通常用手機錄音，回去再自己聽一次打重點，很花時間。"],
      [0, "那最困擾你的是哪個部分？"],
      [1, "找特定段落，例如老闆說了什麼 deadline，常常要來回拖很久。"],
      [0, "如果有自動逐字稿，而且點文字就能跳到那段錄音，對你有幫助嗎？"],
      [1, "非常有幫助，尤其是可以搜尋關鍵字的話。"],
    ],
  },
  review: {
    speakers: ["Alex Chen", "林佳穎", "陳志豪"],
    lines: Array.from({ length: 30 }, (_, i): Line => [i % 3, `設計評審第 ${i + 1} 段討論內容。`]),
  },
};

const CHARS_PER_SEC = 4.2;
function timeline(lines: Line[]) {
  let t = 1200;
  return lines.map(([spk, text], i) => {
    const dur = Math.max(1800, Math.round((text.length / CHARS_PER_SEC) * 1000));
    const seg = { idx: i, speaker: spk, text, start_ms: t, end_ms: t + dur };
    t += dur + 500 + ((i * 37) % 5) * 150;
    return seg;
  });
}

/** Scripted stand-in for the Python workers (same file formats). */
class DemoWorkers implements WorkerPoolLike {
  scriptFor = new Map<string, keyof typeof SCRIPTS>(); // audio path prefix (recording dir) → script
  holdAsr = false;
  current: keyof typeof SCRIPTS = "meeting";

  private pick(p: Record<string, any>) {
    const file = String(p.audio_path ?? p.segments_path ?? p.asr_path ?? "");
    for (const [dir, key] of this.scriptFor) if (file.includes(dir)) return SCRIPTS[key];
    return SCRIPTS[this.current];
  }

  async call<T = any>(_lane: Lane, op: string, p: Record<string, any>, opts: CallOptions = {}): Promise<T> {
    const sig = opts.signal ?? new StageSignal();
    const stop = () => {
      if (sig.reason === "cancel") throw new WorkerCallError("CANCELLED", "cancelled", false);
      return sig.reason === "pause";
    };
    const script = this.pick(p);
    const tl = timeline(script.lines);
    const total = tl[tl.length - 1].end_ms + 1500;
    const step = async (n: number, unit: string, totalUnits: number) => {
      for (let i = 1; i <= n; i++) {
        if (stop()) return false;
        opts.onProgress?.({ done: (totalUnits * i) / n, total: totalUnits, unit });
        await sleep(40);
      }
      return true;
    };
    switch (op) {
      case "health":
        return { demo: true } as T;
      case "vad":
        if (!(await step(5, "s", total / 1000))) return { status: "paused" } as T;
        await writeFileAtomic(p.output_path, JSON.stringify({ version: 1, total_ms: total, speech_ms: tl.reduce((a, s) => a + s.end_ms - s.start_ms, 0), speech_spans: tl.map((s) => [s.start_ms, s.end_ms]), segments: tl.map(({ idx, start_ms, end_ms }) => ({ idx, start_ms, end_ms })) }));
        return { output_path: p.output_path, segments: tl.length, speech_ms: 0, total_ms: total, model_version: "silero-vad onnx (demo)" } as T;
      case "asr": {
        const out = [];
        for (const s of tl) {
          if (stop()) return { status: "paused" } as T;
          if (this.holdAsr && s.idx >= Math.floor(tl.length * 0.46)) await new Promise<void>((r) => sig.on(() => r()));
          if (stop()) return { status: "paused" } as T;
          const lang = /^[A-Za-z]/.test(s.text) ? "English" : "Chinese";
          out.push({ idx: s.idx, start_ms: s.start_ms, end_ms: s.end_ms, language: lang, text_raw: s.text, text: s.text });
          opts.onProgress?.({ done: (s.end_ms - tl[0].start_ms) / 1000, total: (total - tl[0].start_ms) / 1000, unit: "s", detail: { segments_done: out.length, segments_total: tl.length } });
          await sleep(30);
        }
        await writeFileAtomic(p.output_path, JSON.stringify({ version: 1, model: "Qwen/Qwen3-ASR-1.7B-hf", segments: out, languages_ms: { Chinese: total * 0.85, English: total * 0.15 } }));
        return { output_path: p.output_path, segments: out.length, model_version: "Qwen/Qwen3-ASR-1.7B-hf" } as T;
      }
      case "align": {
        const out = tl.map((s) => {
          const toks = [...s.text.matchAll(/[A-Za-z0-9']+|[一-鿿]/g)];
          const span = s.end_ms - s.start_ms;
          return { idx: s.idx, status: "aligned", words: toks.map((m, i) => ({ t: m[0], rs: Math.round((i * span) / toks.length), re: Math.round(((i + 1) * span) / toks.length), cs: m.index, ce: m.index! + m[0].length, aligned: true })) };
        });
        if (!(await step(4, "segments", tl.length))) return { status: "paused" } as T;
        await writeFileAtomic(p.output_path, JSON.stringify({ version: 1, segments: out }));
        return { output_path: p.output_path, segments: out.length, model_version: "Qwen/Qwen3-ForcedAligner-0.6B-hf" } as T;
      }
      case "diarize": {
        const turns = tl.map((s) => ({ speaker: s.speaker, start_ms: s.start_ms - 150, end_ms: s.end_ms + 150 }));
        if (!(await step(5, "s", total / 1000))) return { status: "paused" } as T;
        await writeFileAtomic(p.output_path, JSON.stringify({ version: 1, turns, speakers: [...new Set(tl.map((s) => s.speaker))].sort(), total_ms: total }));
        return { output_path: p.output_path, speakers: script.speakers.length, turns: turns.length, device: "cuda:0", rtfx: 210, model_version: "nvidia/Nemotron-3-Diarization" } as T;
      }
      case "embed": {
        const speakers: Record<string, any> = {};
        for (const [k, spans] of Object.entries(p.speakers as Record<string, number[][]>)) {
          // one stable fake voiceprint per *person* across scripts, so enrolled names auto-match later
          const name = script.speakers[Number(k)] ?? k;
          const h = crypto.createHash("sha256").update(name).digest();
          const v = Array.from({ length: 192 }, (_, i) => (h[i % 32] - 128) / 128);
          speakers[k] = { embedding: v, used_ms: spans.reduce((a, [x, y]) => a + y - x, 0), spans: spans.length, consistency: 0.92 };
        }
        if (p.output_path) await writeFileAtomic(p.output_path, JSON.stringify({ version: 1, dim: 192, speakers }));
        return { output_path: p.output_path ?? null, dim: 192, speakers: p.output_path ? null : speakers, model_version: "nvidia/speakerverification_en_titanet_large" } as T;
      }
    }
    throw new WorkerCallError("BAD_OP", op, false);
  }
  status() {
    return {};
  }
  async restart() {}
  async shutdown() {}
}

// ---- fictional LLM -------------------------------------------------------------------
const cls = (folder: string | null, conf: number, title: string, type: string) => ({
  document_type: type,
  detected_project: folder?.split("/").pop() ?? null,
  suggested_folder: folder,
  new_folder_name: null,
  suggested_title: title,
  classification_confidence: conf,
  classification_reason: folder ? `多次提到 ${folder.split("/").pop()} 的內容與既有筆記相符。` : "沒有明確對應的專案資料夾。",
  evidence: ["00:00:01 會議主題", "00:00:20 相關討論"],
});

class DemoLlm implements LlmAdapter {
  readonly id = "claude" as const;
  async status() {
    return { provider: "claude" as const, installed: true, version: "demo", loggedIn: true, account: "demo", detail: "Demo adapter", efforts: ["low", "medium", "high", "xhigh", "max"] };
  }
  async generate(a: GenerateArgs) {
    const isClass = JSON.stringify(a.schema).includes("course_name");
    const output = isClass
      ? {
          course_name: "機器學習導論",
          title: "梯度下降法與 Learning Rate",
          date: null,
          summary: "介紹梯度下降法的直覺與 learning rate 的取捨，並預告下週的 stochastic gradient descent。",
          core_concepts: [
            { name: "Gradient descent", explanation: "每一步沿負梯度方向更新參數，逐步降低 loss。" },
            { name: "Learning rate", explanation: "步伐大小；過大會震盪或發散，過小收斂緩慢。" },
          ],
          detailed_notes: [{ heading: "下山的比喻", content: "- 蒙眼站在山上，只能感覺腳下坡度\n- 每一步往最陡的下坡方向走", timestamps: ["00:00:09"] }],
          key_terms: [{ term: "Adam", definition: "自適應調整每個參數學習率的最佳化方法。" }],
          emphasized: [{ point: "期中考會考 loss 曲線的三種情況", timestamp: "00:00:51" }],
          examples: [],
          faq: [{ question: "要怎麼選 learning rate？", answer: "常用 learning rate schedule 或 Adam 等 adaptive 方法。" }],
          review_points: ["畫出 learning rate 過大、適中、過小的 loss 曲線", "預讀課本第四章"],
          key_timestamps: [{ time: "00:00:51", description: "期中考重點" }],
          uncertain: [],
          classification: cls("Transcripts/機器學習導論", 0.91, "梯度下降法與 Learning Rate", "class"),
        }
      : {
          title: "產品週會：上線前檢查",
          date: null,
          participants: [
            { name: "林佳穎", evidence: "主持會議並負責 release note" },
            { name: "陳志豪", evidence: "回報後端與 Sentry 狀態" },
            { name: "Alex Chen", evidence: "負責設計與 usability test" },
          ],
          executive_summary: "確認下週二上線前的檢查清單：後端已部署到 staging 並完成 load test，設計已更新 onboarding flow。決議照原定時間上線，深色模式對比度問題延到下一版。",
          topics: [
            { title: "後端與效能", summary: "API 已部署 staging，load test p95 約 180 ms；rate limit 調整為每分鐘 120 次，先觀察一週。", timestamps: ["00:00:12", "00:00:26"] },
            { title: "設計與使用者測試", summary: "onboarding flow 與空狀態插圖完成，週四前進行 usability test。", timestamps: ["00:00:46", "00:01:03"] },
          ],
          decisions: [
            { decision: "下週二照原定時間上線", timestamp: "00:01:31" },
            { decision: "rate limit 先維持每分鐘 120 次", timestamp: "00:01:31" },
            { decision: "深色模式對比度改到下一版處理，先開 ticket 追蹤", timestamp: "00:01:58" },
          ],
          action_items: [
            { task: "與兩位使用者約 usability test", owner: "Alex Chen", deadline: "週四", timestamp: "00:01:10" },
            { task: "準備測試腳本", owner: "林佳穎", deadline: null, timestamp: "00:01:10" },
            { task: "修正 Sentry 的 null pointer 錯誤", owner: "陳志豪", deadline: "週三", timestamp: "00:01:21" },
            { task: "撰寫 release note", owner: "林佳穎", deadline: null, timestamp: "00:02:04" },
          ],
          open_questions: ["rate limit 是否開放給所有方案（觀察一週後決定）"],
          key_timestamps: [{ time: "00:01:31", description: "上線決議" }],
          uncertain: [],
          classification: cls("Transcripts/產品開發", 0.9, "產品週會：上線前檢查", "meeting"),
        };
    return { output, costUsd: 0.04, durationMs: 1200, resolvedModel: "claude-sonnet-5-5" };
  }
}

// ---- seed ------------------------------------------------------------------------------
function speechLikeAudio(seconds: number, file: string) {
  execFileSync("ffmpeg", [
    "-v", "error", "-y", "-f", "lavfi", "-i", `anoisesrc=d=${seconds}:c=pink:a=0.5:r=16000`,
    "-af", "volume='0.08+0.9*abs(sin(2*PI*2.1*t))*abs(sin(2*PI*0.37*t+1))*gt(sin(2*PI*0.18*t),-0.55)':eval=frame,lowpass=f=3400",
    "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "64k", file,
  ]);
  return fs.readFileSync(file);
}

const port = Number(process.argv[2] ?? 8100);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "transcriber-demo-"));
const vault = path.join(dataDir, "vault");
for (const f of ["Transcripts/逐字稿", "Transcripts/產品開發", "Transcripts/機器學習導論", ".obsidian"]) fs.mkdirSync(path.join(vault, f), { recursive: true });

const workers = new DemoWorkers();
const built = await buildApp(
  loadConfig({ dataDir, port, adminUser: "demo", adminPassword: "demo-password", mockWorker: true, secureCookies: false, allowedOrigins: [`http://127.0.0.1:${port}`, `http://localhost:${port}`] }),
  { workers, llmAdapters: { claude: new DemoLlm(), codex: new DemoLlm() as any }, logger: false },
);
const { app } = built;
let cookie = "";
const req = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
  const isBuf = Buffer.isBuffer(body);
  const r = await app.inject({ method: method as any, url, payload: body === undefined ? undefined : isBuf ? (body as Buffer) : JSON.stringify(body), headers: { cookie, ...(body !== undefined ? { "content-type": isBuf ? "application/octet-stream" : "application/json" } : {}), ...headers } });
  const sc = r.headers["set-cookie"];
  if (sc) cookie = String(sc).split(";")[0];
  return r.json();
};
await req("POST", "/api/auth/login", { username: "demo", password: "demo-password" });
await req("PATCH", "/api/settings", { obsidian: { backend: "filesystem", vaultRoot: vault, vaultName: "My Vault", autoExport: true, transRoot: "Transcripts", transcriptFolder: "Transcripts/逐字稿", pendingFolder: "Transcripts/待整理", allowedRoots: ["Transcripts"], scanRoots: ["Transcripts"] }, identify: { minTotalCleanSec: 1 } });

async function upload(name: string, script: keyof typeof SCRIPTS, seconds: number, options: Record<string, unknown>, recordedAt: string) {
  const audio = speechLikeAudio(seconds, path.join(dataDir, `${script}.mp3`));
  workers.current = script;
  const s = await req("POST", "/api/uploads", { filename: name, size: audio.length, fingerprint: name, options: { ...options, recordedAt } });
  for (let i = 0; i < s.totalChunks; i++) {
    const part = audio.subarray(i * s.chunkSize, (i + 1) * s.chunkSize);
    await req("PUT", `/api/uploads/${s.id}/chunks/${i}`, part, { "x-chunk-sha256": crypto.createHash("sha256").update(part).digest("hex") });
  }
  const done = await req("POST", `/api/uploads/${s.id}/complete`, {});
  workers.scriptFor.set(done.recordingId, script);
  return done as { recordingId: string; jobId: string };
}
async function wait(jobId: string) {
  for (;;) {
    const j = await req("GET", `/api/jobs/${jobId}`);
    if (["completed", "failed"].includes(j.status)) return j;
    await sleep(100);
  }
}
async function name(recordingId: string, names: string[]) {
  const tr = await req("GET", `/api/recordings/${recordingId}/transcript`);
  for (const s of tr.speakers) if (names[s.diarIndex]) await req("PATCH", `/api/recording-speakers/${s.id}`, { newName: names[s.diarIndex], enroll: true });
}

const interview = await upload("使用者訪談 #4.m4a", "interview", 40, { title: "使用者訪談 #4", noteTemplate: "none" }, "2026-10-14T06:00:00.000Z");
await wait(interview.jobId);
await name(interview.recordingId, ["林佳穎"]);
const lecture = await upload("ML 第三週.mp3", "class", 75, { title: "機器學習導論 第 3 週", noteTemplate: "class" }, "2026-10-16T02:00:00.000Z");
await wait(lecture.jobId);
await name(lecture.recordingId, ["王教授"]);
const meeting = await upload("weekly-sync.m4a", "meeting", 140, { title: "產品週會", noteTemplate: "meeting", vocabulary: "staging, rate limit, onboarding, Sentry" }, "2026-10-19T02:00:00.000Z");
await wait(meeting.jobId);
await name(meeting.recordingId, ["", "陳志豪", "Alex Chen"]); // 林佳穎 is matched automatically from the earlier interview
workers.holdAsr = true;
await upload("design-review.m4a", "review", 600, { title: "設計評審", noteTemplate: "meeting" }, "2026-10-19T07:00:00.000Z");

await app.listen({ host: "127.0.0.1", port });
console.log(`demo ready on http://127.0.0.1:${port}  (demo / demo-password)  meeting=${meeting.recordingId}`);
