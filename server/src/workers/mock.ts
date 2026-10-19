import fs from "node:fs";
import { writeFileAtomic, sleep } from "../lib/util.js";
import { StageSignal, WorkerCallError, type CallOptions, type Lane, type WorkerPoolLike } from "./pool.js";

/**
 * Deterministic stand-in for the Python workers, used by automated integration tests
 * (and MOCK_WORKER=1 dev runs). It writes files in exactly the formats the real worker
 * produces, honours pause/cancel at segment boundaries and can inject failures.
 * It is never used for model acceptance.
 */
export class MockWorkerPool implements WorkerPoolLike {
  stepMs = 5;
  failures: { op: string; code: string; times: number; retryable?: boolean }[] = [];
  calls: { lane: Lane; op: string }[] = [];
  /** Audio duration assumed for the fake recording when the file is not a real WAV. */
  durationMs = 60_000;

  async call<T = any>(lane: Lane, op: string, p: Record<string, any>, opts: CallOptions = {}): Promise<T> {
    this.calls.push({ lane, op });
    const f = this.failures.find((x) => x.op === op && x.times > 0);
    if (f) {
      f.times--;
      throw new WorkerCallError(f.code, `injected ${f.code}`, f.retryable ?? f.code === "OOM");
    }
    const sig = opts.signal ?? new StageSignal();
    const check = () => {
      if (sig.reason === "cancel") throw new WorkerCallError("CANCELLED", "cancelled", false);
      return sig.reason === "pause";
    };
    const dur = this.durationMs;
    switch (op) {
      case "health":
        return { lane, mock: true } as T;
      case "vad": {
        const segs = [];
        for (let s = 0, i = 0; s < dur; s += 10_000, i++) segs.push({ idx: i, start_ms: s, end_ms: Math.min(dur, s + 9_000) });
        for (let i = 0; i <= 4; i++) {
          if (check()) return { status: "paused" } as T;
          opts.onProgress?.({ done: (dur / 1000) * (i / 4), total: dur / 1000, unit: "s" });
          await sleep(this.stepMs);
        }
        await writeFileAtomic(p.output_path, JSON.stringify({ version: 1, total_ms: dur, speech_ms: segs.length * 9000, speech_spans: segs.map((s) => [s.start_ms, s.end_ms]), segments: segs }));
        return { output_path: p.output_path, segments: segs.length, model_version: "mock-vad" } as T;
      }
      case "asr": {
        const plan = JSON.parse(fs.readFileSync(p.segments_path, "utf8"));
        const ck = readCk(p.checkpoint_path);
        const total = plan.segments.length;
        for (const s of plan.segments) {
          if (ck[s.idx]) continue;
          if (check()) {
            writeCk(p.checkpoint_path, ck);
            return { status: "paused" } as T;
          }
          await sleep(this.stepMs);
          const zh = s.idx % 2 === 0;
          ck[s.idx] = {
            idx: s.idx,
            start_ms: s.start_ms,
            end_ms: s.end_ms,
            language: zh ? "Chinese" : "English",
            text_raw: zh ? `第${s.idx}段测试内容。` : `Segment ${s.idx} test. Second sentence here.`,
            text: zh ? `第${s.idx}段測試內容。` : `Segment ${s.idx} test. Second sentence here.`,
          };
          writeCk(p.checkpoint_path, ck);
          opts.onProgress?.({ done: Object.keys(ck).length, total, unit: "segments" });
        }
        await writeFileAtomic(p.output_path, JSON.stringify({ version: 1, model: "mock-asr", segments: plan.segments.map((s: any) => ck[s.idx]) }));
        return { output_path: p.output_path, segments: total, model_version: "mock-asr" } as T;
      }
      case "align": {
        const asr = JSON.parse(fs.readFileSync(p.asr_path, "utf8"));
        const out = [];
        for (const s of asr.segments) {
          if (check()) return { status: "paused" } as T;
          const toks = [...s.text.matchAll(/[A-Za-z0-9]+|[一-鿿]/g)];
          const span = s.end_ms - s.start_ms;
          out.push({
            idx: s.idx,
            status: "aligned",
            words: toks.map((m, i) => ({
              t: m[0],
              rs: Math.round((i * span) / toks.length),
              re: Math.round(((i + 1) * span) / toks.length),
              cs: m.index,
              ce: m.index! + m[0].length,
              aligned: true,
            })),
          });
          opts.onProgress?.({ done: out.length, total: asr.segments.length, unit: "segments" });
          await sleep(this.stepMs);
        }
        await writeFileAtomic(p.output_path, JSON.stringify({ version: 1, model: "mock-align", segments: out }));
        return { output_path: p.output_path, segments: out.length, model_version: "mock-align" } as T;
      }
      case "diarize": {
        const turns = [];
        for (let s = 0, i = 0; s < dur; s += 10_000, i++) turns.push({ speaker: i % 2, start_ms: s, end_ms: Math.min(dur, s + 9_500) });
        for (let i = 0; i <= 4; i++) {
          if (check()) return { status: "paused" } as T;
          opts.onProgress?.({ done: (dur / 1000) * (i / 4), total: dur / 1000, unit: "s" });
          await sleep(this.stepMs);
        }
        await writeFileAtomic(p.output_path, JSON.stringify({ version: 1, model: "mock-diar", device: p.device, turns, speakers: [0, 1], total_ms: dur }));
        return { output_path: p.output_path, speakers: 2, device: p.device, model_version: "mock-diar" } as T;
      }
      case "embed": {
        const speakers: Record<string, any> = {};
        for (const [k, spans] of Object.entries(p.speakers as Record<string, number[][]>)) {
          if (check()) return { status: "paused" } as T;
          const v = Array.from({ length: 192 }, (_, i) => (i === Number(k) % 192 ? 1 : 0));
          speakers[k] = { embedding: v, used_ms: spans.reduce((a, [x, y]) => a + y - x, 0), spans: spans.length, consistency: 0.9 };
        }
        const result = { version: 1, model: "mock-titanet", dim: 192, speakers };
        if (p.output_path) await writeFileAtomic(p.output_path, JSON.stringify(result));
        return { output_path: p.output_path ?? null, dim: 192, speakers: p.output_path ? null : speakers, model_version: "mock-titanet" } as T;
      }
      default:
        throw new WorkerCallError("BAD_OP", op, false);
    }
  }

  status() {
    return {};
  }
  async restart() {}
  async shutdown() {}
}

function readCk(file?: string): Record<string, any> {
  if (!file || !fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, "utf8")).items ?? {};
}
function writeCk(file: string | undefined, items: Record<string, any>) {
  if (!file) return;
  fs.writeFileSync(file, JSON.stringify({ version: 1, items }));
}
