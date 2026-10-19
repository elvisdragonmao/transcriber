import { useSyncExternalStore } from "react";
import type { UploadOptions } from "./upload";

/** Processing options for the next uploads; shared by the home page form and window-wide drag & drop. */
export interface StoredUploadOptions {
  language: "auto" | "zh" | "en";
  vocabulary: string;
  /** null = follow the default template from Settings */
  noteTemplate: "none" | "meeting" | "class" | null;
  projectId: string | null;
  /** null = follow Settings → Obsidian → auto export */
  autoExport: boolean | null;
}

const KEY = "transcriber.uploadOptions.v1";
const DEFAULTS: StoredUploadOptions = { language: "auto", vocabulary: "", noteTemplate: null, projectId: null, autoExport: null };

function load(): StoredUploadOptions {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return DEFAULTS;
  }
}

let state = load();
const listeners = new Set<() => void>();

export function setUploadOptions(patch: Partial<StoredUploadOptions>) {
  state = { ...state, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* per-browser convenience only */
  }
  listeners.forEach((l) => l());
}

export function useUploadOptions(): StoredUploadOptions {
  return useSyncExternalStore(
    (cb) => (listeners.add(cb), () => listeners.delete(cb)),
    () => state,
  );
}

/** Resolve the stored options against server settings into what the upload API expects. */
export function resolveUploadOptions(settings: any, title?: string): UploadOptions {
  const s = state;
  return {
    title: title?.trim() || undefined,
    language: s.language,
    vocabulary: s.vocabulary,
    noteTemplate: s.noteTemplate ?? settings?.llm?.defaultTemplate ?? "none",
    projectId: s.projectId,
    autoExport: s.autoExport ?? undefined,
  };
}
