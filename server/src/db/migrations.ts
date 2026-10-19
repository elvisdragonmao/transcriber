export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: "init",
    sql: /* sql */ `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE auth_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  user_agent TEXT
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  vault_folder TEXT UNIQUE,
  kind TEXT NOT NULL DEFAULT 'project' CHECK (kind IN ('project','course','other')),
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('vault','manual','ai')),
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE recordings (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  title_source TEXT NOT NULL DEFAULT 'filename' CHECK (title_source IN ('filename','user','ai')),
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  original_filename TEXT NOT NULL,
  mime_type TEXT,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  source_path TEXT,
  audio_path TEXT,
  peaks_path TEXT,
  duration_ms INTEGER,
  sample_rate INTEGER,
  channels INTEGER,
  codec TEXT,
  container TEXT,
  recorded_at TEXT,
  language_hint TEXT NOT NULL DEFAULT 'auto' CHECK (language_hint IN ('auto','zh','en')),
  vocabulary TEXT NOT NULL DEFAULT '',
  note_template TEXT NOT NULL DEFAULT 'none' CHECK (note_template IN ('none','meeting','class')),
  document_type TEXT,
  audio_deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX recordings_created ON recordings(created_at DESC);

CREATE TABLE upload_sessions (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  safe_name TEXT NOT NULL,
  mime_type TEXT,
  extension TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  chunk_size INTEGER NOT NULL CHECK (chunk_size > 0),
  total_chunks INTEGER NOT NULL CHECK (total_chunks > 0),
  fingerprint TEXT,
  last_modified INTEGER,
  options TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('active','assembling','completed','failed','cancelled')),
  received_bytes INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT,
  recording_id TEXT REFERENCES recordings(id) ON DELETE SET NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX upload_sessions_owner_fp ON upload_sessions(owner_id, fingerprint);

CREATE TABLE upload_chunks (
  session_id TEXT NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  offset INTEGER NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (session_id, chunk_index)
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('transcription','notes','export')),
  status TEXT NOT NULL CHECK (status IN ('queued','running','pausing','paused','cancelling','cancelled','completed','failed')),
  options TEXT NOT NULL DEFAULT '{}',
  progress REAL NOT NULL DEFAULT 0,
  current_stage TEXT,
  error TEXT,
  keep_partial INTEGER NOT NULL DEFAULT 1,
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX jobs_status ON jobs(status, created_at);
CREATE INDEX jobs_recording ON jobs(recording_id);

CREATE TABLE job_stages (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  seq INTEGER NOT NULL,
  lane TEXT NOT NULL,
  depends_on TEXT NOT NULL DEFAULT '[]',
  weight REAL NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','running','paused','completed','failed','skipped','cancelled')),
  progress REAL,
  progress_done REAL,
  progress_total REAL,
  progress_unit TEXT,
  progress_detail TEXT,
  rate_started_at TEXT,
  rate_base_done REAL,
  started_at TEXT,
  ended_at TEXT,
  error TEXT,
  error_code TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 2,
  next_attempt_at TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  checkpoint_path TEXT,
  output_path TEXT,
  model_version TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (job_id, name)
);
CREATE INDEX job_stages_status ON job_stages(status);

CREATE TABLE job_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  stage TEXT,
  level TEXT NOT NULL CHECK (level IN ('info','warn','error')),
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  data TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX job_events_job ON job_events(job_id, id);

CREATE TABLE transcripts (
  id TEXT PRIMARY KEY,
  recording_id TEXT NOT NULL UNIQUE REFERENCES recordings(id) ON DELETE CASCADE,
  job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  language TEXT,
  languages TEXT,
  model_info TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('partial','complete')),
  revision INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE asr_segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transcript_id TEXT NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  language TEXT,
  text_raw TEXT NOT NULL,
  text TEXT NOT NULL,
  aligned INTEGER NOT NULL DEFAULT 0,
  UNIQUE (transcript_id, idx)
);

CREATE TABLE speakers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE speaker_aliases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  speaker_id TEXT NOT NULL REFERENCES speakers(id) ON DELETE CASCADE,
  alias TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE recording_speakers (
  id TEXT PRIMARY KEY,
  recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  diar_index INTEGER NOT NULL,
  label TEXT NOT NULL,
  speaker_id TEXT REFERENCES speakers(id) ON DELETE SET NULL,
  assignment TEXT NOT NULL DEFAULT 'unknown' CHECK (assignment IN ('auto','manual','unknown','suggested')),
  match_score REAL,
  match_margin REAL,
  suggested_speaker_id TEXT REFERENCES speakers(id) ON DELETE SET NULL,
  speech_ms INTEGER NOT NULL DEFAULT 0,
  clean_speech_ms INTEGER NOT NULL DEFAULT 0,
  embedding BLOB,
  embedding_model TEXT,
  color INTEGER NOT NULL DEFAULT 0,
  UNIQUE (recording_id, diar_index)
);

CREATE TABLE diarization_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  diar_index INTEGER NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL
);
CREATE INDEX diarization_turns_rec ON diarization_turns(recording_id, start_ms);

CREATE TABLE transcript_segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transcript_id TEXT NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  recording_speaker_id TEXT REFERENCES recording_speakers(id) ON DELETE SET NULL,
  original_recording_speaker_id TEXT,
  speaker_status TEXT NOT NULL CHECK (speaker_status IN ('assigned','overlap','uncertain','manual')),
  overlap_speakers TEXT,
  text TEXT NOT NULL,
  text_original TEXT NOT NULL,
  edited_at TEXT,
  UNIQUE (transcript_id, idx)
);
CREATE INDEX transcript_segments_time ON transcript_segments(transcript_id, start_ms);

CREATE TABLE words (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transcript_id TEXT NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
  segment_id INTEGER REFERENCES transcript_segments(id) ON DELETE CASCADE,
  asr_segment_id INTEGER REFERENCES asr_segments(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  text TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  rel_start_ms INTEGER NOT NULL,
  rel_end_ms INTEGER NOT NULL,
  recording_speaker_id TEXT,
  aligned INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX words_segment ON words(segment_id);
CREATE INDEX words_time ON words(transcript_id, start_ms);

CREATE TABLE segment_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  segment_id INTEGER NOT NULL REFERENCES transcript_segments(id) ON DELETE CASCADE,
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE speaker_embeddings (
  id TEXT PRIMARY KEY,
  speaker_id TEXT NOT NULL REFERENCES speakers(id) ON DELETE CASCADE,
  recording_id TEXT REFERENCES recordings(id) ON DELETE SET NULL,
  recording_speaker_id TEXT REFERENCES recording_speakers(id) ON DELETE SET NULL,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  vector BLOB NOT NULL,
  speech_ms INTEGER,
  language TEXT,
  source TEXT NOT NULL CHECK (source IN ('manual','auto_confirmed','clip')),
  created_at TEXT NOT NULL
);
CREATE INDEX speaker_embeddings_speaker ON speaker_embeddings(speaker_id);

CREATE TABLE note_generations (
  id TEXT PRIMARY KEY,
  recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  template TEXT NOT NULL CHECK (template IN ('meeting','class')),
  provider TEXT NOT NULL,
  model TEXT,
  effort TEXT,
  language TEXT,
  status TEXT NOT NULL CHECK (status IN ('running','completed','failed','cancelled')),
  error TEXT,
  cost_usd REAL,
  duration_ms INTEGER,
  created_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE generated_notes (
  id TEXT PRIMARY KEY,
  generation_id TEXT REFERENCES note_generations(id) ON DELETE SET NULL,
  recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  template TEXT NOT NULL,
  title TEXT NOT NULL,
  markdown TEXT NOT NULL,
  structured TEXT NOT NULL,
  classification TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX generated_notes_rec ON generated_notes(recording_id);

CREATE TABLE obsidian_exports (
  id TEXT PRIMARY KEY,
  recording_id TEXT REFERENCES recordings(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('transcript','note')),
  note_id TEXT REFERENCES generated_notes(id) ON DELETE SET NULL,
  backend TEXT NOT NULL,
  vault_path TEXT NOT NULL,
  content_sha256 TEXT,
  status TEXT NOT NULL CHECK (status IN ('written','pending_review','superseded','deleted','failed')),
  suggested_path TEXT,
  classification TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX obsidian_exports_rec ON obsidian_exports(recording_id);

CREATE TABLE llm_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  model TEXT,
  purpose TEXT NOT NULL,
  cost_usd REAL,
  duration_ms INTEGER,
  ok INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
`,
  },
];
