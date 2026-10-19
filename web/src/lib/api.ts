export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: any,
  ) {
    super(message);
  }
}

export async function api<T = any>(method: string, url: string, body?: unknown, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    ...init,
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith("/api/auth/")) window.dispatchEvent(new Event("auth:required"));
    throw new ApiError(res.status, data?.error ?? "error", data?.message ?? res.statusText, data?.details);
  }
  return data as T;
}

export const get = <T = any>(url: string) => api<T>("GET", url);
export const post = <T = any>(url: string, body: unknown = {}) => api<T>("POST", url, body);
export const patch = <T = any>(url: string, body: unknown) => api<T>("PATCH", url, body);
export const del = <T = any>(url: string, body: unknown = {}) => api<T>("DELETE", url, body);

// ---- shared types --------------------------------------------------------------

export type JobStatus = "queued" | "running" | "pausing" | "paused" | "cancelling" | "cancelled" | "completed" | "failed";

export interface Stage {
  name: string;
  label: string;
  lane: string;
  status: "pending" | "running" | "paused" | "completed" | "failed" | "skipped" | "cancelled";
  progress: number | null;
  done: number | null;
  total: number | null;
  unit: string | null;
  detail: any;
  startedAt: string | null;
  endedAt: string | null;
  error: string | null;
  errorCode: string | null;
  retryCount: number;
  maxRetries: number;
  nextAttemptAt: string | null;
  etaSeconds: number | null;
  modelVersion: string | null;
}

export interface Job {
  id: string;
  recordingId: string;
  recordingTitle: string | null;
  durationMs: number | null;
  type: "transcription" | "notes" | "export";
  status: JobStatus;
  progress: number;
  currentStage: string | null;
  error: string | null;
  options: any;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  etaSeconds: number | null;
  stages: Stage[];
  events?: { id: number; stage: string | null; level: string; type: string; message: string; data: string | null; created_at: string }[];
}

export interface Recording {
  id: string;
  title: string;
  titleSource: string;
  project: { id: string; name: string; vault_folder: string | null } | null;
  originalFilename: string;
  sizeBytes: number;
  durationMs: number | null;
  codec: string | null;
  recordedAt: string | null;
  languageHint: "auto" | "zh" | "en";
  vocabulary: string;
  noteTemplate: "none" | "meeting" | "class";
  documentType: string | null;
  hasAudio: boolean;
  audioDeletedAt: string | null;
  transcript: { status: string; language: string | null; revision: number } | null;
  speakerCount: number;
  noteCount: number;
  activeJobs: { id: string; type: string; status: JobStatus; progress: number; current_stage: string | null }[];
  lastJob: { id: string; type: string; status: string; error: string | null } | null;
  createdAt: string;
  updatedAt: string;
}

export interface RecordingSpeaker {
  id: string;
  diarIndex: number;
  label: string;
  speakerId: string | null;
  name: string;
  assignment: "auto" | "manual" | "unknown" | "suggested";
  matchScore: number | null;
  matchMargin: number | null;
  suggestedSpeakerId: string | null;
  suggestedName: string | null;
  speechMs: number;
  cleanSpeechMs: number;
  color: number;
  hasEmbedding: boolean;
}

export interface Segment {
  id: number;
  start: number;
  end: number;
  speakerId: string | null;
  originalSpeakerId: string | null;
  status: "assigned" | "overlap" | "uncertain" | "manual";
  overlapSpeakers: string[];
  text: string;
  textOriginal: string;
  edited: boolean;
  words?: { t: string; s: number; e: number; a: boolean }[];
}

export interface Transcript {
  id: string;
  status: string;
  language: string | null;
  languages: Record<string, number>;
  modelInfo: Record<string, string>;
  revision: number;
  speakers: RecordingSpeaker[];
  segments: Segment[];
}

export interface Speaker {
  id: string;
  name: string;
  notes: string | null;
  embeddings: number;
  enrolledMs: number;
  recordings: number;
  aliases: string[];
}

export interface NoteItem {
  id: string;
  template: "meeting" | "class";
  title: string;
  markdown: string;
  classification: any;
  provider: string | null;
  model: string | null;
  effort: string | null;
  costUsd: number | null;
  createdAt: string;
}

export interface ExportItem {
  id: string;
  kind: "transcript" | "note";
  noteId: string | null;
  path: string;
  status: "written" | "pending_review" | "superseded" | "deleted" | "failed";
  suggestedPath: string | null;
  classification: any;
  uri: string;
  createdAt: string;
}
