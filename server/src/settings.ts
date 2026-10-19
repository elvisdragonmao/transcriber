import { z } from "zod";
import type { DB } from "./db/index.js";
import { nowIso } from "./lib/util.js";

export const TRANS_ROOT = "50 🏳️‍⚧️ Trans";

const gpuSchema = z.object({
  /** GPU UUID (from nvidia-smi) used for ASR + forced alignment. Never a bare index. */
  asrDevice: z.string().default(""),
  /** GPU UUID used for Nemotron diarization, or "cpu". */
  diarDevice: z.string().default(""),
  /** What to do when the diarization GPU is unusable: run on CPU (slow) or fail clearly. */
  diarFallback: z.enum(["cpu", "fail"]).default("cpu"),
  /** Keep ASR and aligner resident together if they fit; otherwise load sequentially. */
  coResident: z.enum(["auto", "always", "never"]).default("auto"),
  idleUnloadSec: z.number().int().min(30).max(86400).default(900),
});

const vadSchema = z.object({
  threshold: z.number().min(0.05).max(0.95).default(0.4),
  minSpeechMs: z.number().int().min(50).max(5000).default(200),
  minSilenceMs: z.number().int().min(50).max(5000).default(400),
  speechPadMs: z.number().int().min(0).max(2000).default(300),
});

const asrSchema = z.object({
  model: z.string().default("Qwen/Qwen3-ASR-1.7B-hf"),
  alignerModel: z.string().default("Qwen/Qwen3-ForcedAligner-0.6B-hf"),
  maxSegmentSec: z.number().min(5).max(120).default(28),
  minSegmentSec: z.number().min(0.5).max(30).default(1),
  maxMergeGapSec: z.number().min(0).max(10).default(1.2),
  contextChars: z.number().int().min(0).max(1000).default(120),
  maxNewTokens: z.number().int().min(64).max(2048).default(512),
  chineseScript: z.enum(["s2twp", "s2tw", "none"]).default("s2twp"),
  defaultLanguage: z.enum(["auto", "zh", "en"]).default("auto"),
  /** Loudness-normalise (ffmpeg speechnorm) the copy used by VAD/ASR/alignment. */
  normalize: z.boolean().default(true),
});

const diarSchema = z.object({
  model: z.string().default("nvidia/Nemotron-3-Diarization"),
  /** Streaming Sortformer settings in 80 ms frames (model card "very high latency / offline" preset). */
  spkcacheLen: z.number().int().default(264),
  fifoLen: z.number().int().default(40),
  chunkLen: z.number().int().default(340),
  rightContext: z.number().int().default(40),
  updatePeriod: z.number().int().default(300),
  maxSpeakers: z.number().int().min(1).max(8).default(8),
});

const identifySchema = z.object({
  model: z.string().default("nvidia/speakerverification_en_titanet_large"),
  enabled: z.boolean().default(true),
  /** Cosine similarity thresholds per language. Conservative by default; calibrate with real data. */
  thresholdEn: z.number().min(0).max(1).default(0.72),
  thresholdZh: z.number().min(0).max(1).default(0.78),
  thresholdOther: z.number().min(0).max(1).default(0.8),
  minMargin: z.number().min(0).max(1).default(0.1),
  suggestBelowBy: z.number().min(0).max(1).default(0.12),
  minCleanSegmentSec: z.number().min(0.5).max(10).default(1.5),
  maxCleanSpeechSec: z.number().min(5).max(600).default(90),
  minTotalCleanSec: z.number().min(1).max(120).default(6),
});

const uploadSchema = z.object({
  maxFileBytes: z.number().int().min(1).default(6 * 1024 ** 3),
  concurrency: z.number().int().min(1).max(8).default(4),
  smallChunk: z.number().int().default(8 * 1024 ** 2),
  mediumChunk: z.number().int().default(16 * 1024 ** 2),
  largeChunk: z.number().int().default(32 * 1024 ** 2),
  mediumThreshold: z.number().int().default(256 * 1024 ** 2),
  largeThreshold: z.number().int().default(1024 ** 3),
  sessionTtlHours: z.number().int().min(1).max(24 * 30).default(72),
});

const queueSchema = z.object({
  cpuConcurrency: z.number().int().min(1).max(8).default(2),
  llmConcurrency: z.number().int().min(1).max(4).default(1),
  stallTimeoutSec: z.number().int().min(60).default(1800),
  weights: z
    .record(z.string(), z.number().min(0))
    .default({ upload: 3, prepare: 4, vad: 4, asr: 40, align: 12, diarize: 12, identify: 8, merge: 3, save: 2, notes: 10, export: 2 }),
});

const llmSchema = z.object({
  provider: z.enum(["claude", "codex"]).default("claude"),
  claude: z
    .object({
      models: z.array(z.string()).default(["sonnet", "opus", "fable", "haiku"]),
      model: z.string().default("sonnet"),
      effort: z.string().default("medium"),
    })
    .default({ models: ["sonnet", "opus", "fable", "haiku"], model: "sonnet", effort: "medium" }),
  codex: z
    .object({ models: z.array(z.string()).default([]), model: z.string().default(""), effort: z.string().default("medium") })
    .default({ models: [], model: "", effort: "medium" }),
  verifiedModels: z.record(z.string(), z.string()).default({}),
  language: z.string().default("zh-TW"),
  defaultTemplate: z.enum(["none", "meeting", "class"]).default("none"),
  timeoutSec: z.number().int().min(30).max(3600).default(600),
  maxBudgetUsd: z.number().min(0.01).max(50).default(2),
  dailyCallLimit: z.number().int().min(1).max(1000).default(40),
  maxTranscriptChars: z.number().int().min(1000).default(400000),
});

const obsidianSchema = z.object({
  backend: z.enum(["none", "filesystem", "livesync-mcp"]).default("none"),
  vaultRoot: z.string().default(""),
  vaultName: z.string().default(""),
  transRoot: z.string().default(TRANS_ROOT),
  transcriptFolder: z.string().default(`${TRANS_ROOT}/逐字稿`),
  pendingFolder: z.string().default(`${TRANS_ROOT}/待整理`),
  /** Vault-relative folders the system may write into. Everything else is refused. */
  allowedRoots: z.array(z.string()).default([TRANS_ROOT]),
  /** Vault-relative folders scanned (read-only) for project/course context. */
  scanRoots: z.array(z.string()).default([TRANS_ROOT, "10 💻 Projects", "20 🗿 Knowledge/School"]),
  autoExport: z.boolean().default(true),
  autoFileConfidence: z.number().min(0).max(1).default(0.75),
  transcriptName: z.string().default("{yymmdd} {title} 逐字稿"),
  meetingName: z.string().default("{yymmdd} {title} 會議記錄"),
  className: z.string().default("{yymmdd} {title} 上課筆記"),
  useSemanticSearch: z.boolean().default(true),
});

const storageSchema = z.object({
  cleanupIntermediatesDays: z.number().int().min(0).max(3650).default(14),
  cleanupFailedUploadsHours: z.number().int().min(1).max(24 * 30).default(72),
  minFreeBytes: z.number().int().min(0).default(3 * 1024 ** 3),
});

export const settingsSchema = z.object({
  gpu: gpuSchema.default(gpuSchema.parse({})),
  vad: vadSchema.default(vadSchema.parse({})),
  asr: asrSchema.default(asrSchema.parse({})),
  diar: diarSchema.default(diarSchema.parse({})),
  identify: identifySchema.default(identifySchema.parse({})),
  upload: uploadSchema.default(uploadSchema.parse({})),
  queue: queueSchema.default(queueSchema.parse({})),
  llm: llmSchema.default(llmSchema.parse({})),
  obsidian: obsidianSchema.default(obsidianSchema.parse({})),
  storage: storageSchema.default(storageSchema.parse({})),
});

export type Settings = z.infer<typeof settingsSchema>;
export type SettingsSection = keyof Settings;

export class SettingsStore {
  private cache: Settings | null = null;
  constructor(private db: DB) {}

  get(): Settings {
    if (this.cache) return this.cache;
    const rows = this.db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
    const raw: Record<string, unknown> = {};
    for (const r of rows) {
      try {
        raw[r.key] = JSON.parse(r.value);
      } catch {
        /* ignore corrupt row; defaults apply */
      }
    }
    const parsed = settingsSchema.safeParse(raw);
    this.cache = parsed.success ? parsed.data : settingsSchema.parse({});
    return this.cache;
  }

  /** Merge a partial update into one or more sections. Validates the whole result before saving. */
  update(patch: Partial<{ [K in SettingsSection]: Partial<Settings[K]> }>): Settings {
    const current = this.get();
    const next: Record<string, unknown> = { ...current };
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in current)) throw new Error(`unknown settings section: ${k}`);
      next[k] = { ...(current as any)[k], ...(v as object) };
    }
    const validated = settingsSchema.parse(next);
    const stmt = this.db.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    );
    this.db.transaction(() => {
      for (const k of Object.keys(patch)) stmt.run(k, JSON.stringify((validated as any)[k]), nowIso());
    })();
    this.cache = validated;
    return validated;
  }
}
