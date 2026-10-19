import type { StageHandler } from "./types.js";
import { prepare } from "./prepare.js";
import { align, asr, diarize, identify, merge, save, vad } from "./model.js";
import { notes } from "./notes.js";
import { exportStage } from "./exporter.js";

export type { StageOutcome, StageHandler, StageContext } from "./types.js";

export const stageHandlers: Record<string, StageHandler> = {
  upload: async () => ({ kind: "completed" }),
  prepare,
  vad,
  asr,
  align,
  diarize,
  identify,
  merge,
  save,
  notes,
  export: exportStage,
};
