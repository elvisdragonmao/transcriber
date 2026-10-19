import type { AppContext } from "../context.js";
import type { JobRow, StageRow } from "../queue/jobs.js";
import type { StageSignal } from "../workers/pool.js";

export interface StageContext {
  app: AppContext;
  job: JobRow;
  stage: StageRow;
  signal: StageSignal;
  progress: (done: number, total: number | null, unit: string, detail?: Record<string, unknown>) => void;
  log: (level: "info" | "warn" | "error", message: string, data?: unknown) => void;
  setLane: (lane: string) => void;
}

export type StageOutcome =
  | { kind: "completed" | "skipped"; outputPath?: string; modelVersion?: string; detail?: Record<string, unknown>; message?: string }
  | { kind: "paused" };

export type StageHandler = (ctx: StageContext) => Promise<StageOutcome>;
