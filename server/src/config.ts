import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { randomUUID } from "node:crypto";

function loadDotEnv(file: string) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
loadDotEnv(process.env.TRANSCRIBER_ENV_FILE ?? path.join(projectRoot, ".env"));

const env = (k: string, d?: string) => process.env[k] ?? d;
const bool = (k: string, d = false) => {
  const v = process.env[k];
  return v === undefined ? d : ["1", "true", "yes", "on"].includes(v.toLowerCase());
};

export interface AppConfig {
  projectRoot: string;
  host: string;
  port: number;
  dataDir: string;
  publicOrigin: string | null;
  allowedOrigins: string[];
  trustProxy: boolean;
  secureCookies: boolean;
  instanceId: string;
  adminUser: string;
  adminPassword: string | null;
  workerPython: string;
  workerDir: string;
  hfHome: string | null;
  mockWorker: boolean;
  ffmpeg: string;
  ffprobe: string;
  claudeBin: string;
  codexBin: string;
  cliHome: string;
  obsidianMcpUrl: string | null;
  obsidianMcpToken: string | null;
  semanticMcpUrl: string | null;
  semanticMcpToken: string | null;
  lanOnly: boolean;
  logLevel: string;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const dataDir = path.resolve(env("DATA_DIR", path.join(projectRoot, "data"))!);
  const origin = env("PUBLIC_ORIGIN") || null;
  const cfg: AppConfig = {
    projectRoot,
    host: env("HOST", "127.0.0.1")!,
    port: Number(env("PORT", "8000")),
    dataDir,
    publicOrigin: origin,
    allowedOrigins: (env("ALLOWED_ORIGINS", origin ?? "") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    trustProxy: bool("TRUST_PROXY", true),
    secureCookies: bool("SECURE_COOKIES", !!origin?.startsWith("https://")),
    instanceId: `${os.hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`,
    adminUser: env("ADMIN_USER", "admin")!,
    adminPassword: env("ADMIN_PASSWORD") || null,
    workerPython: env("WORKER_PYTHON", path.join(projectRoot, "worker", ".venv", "bin", "python"))!,
    workerDir: env("WORKER_DIR", path.join(projectRoot, "worker"))!,
    hfHome: env("HF_HOME") || null,
    mockWorker: bool("MOCK_WORKER", false),
    ffmpeg: env("FFMPEG_BIN", "ffmpeg")!,
    ffprobe: env("FFPROBE_BIN", "ffprobe")!,
    claudeBin: env("CLAUDE_BIN", path.join(os.homedir(), ".local", "bin", "claude"))!,
    codexBin: env("CODEX_BIN", path.join(os.homedir(), ".npm-global", "bin", "codex"))!,
    cliHome: env("CLI_HOME", os.homedir())!,
    obsidianMcpUrl: env("OBSIDIAN_MCP_URL") || null,
    obsidianMcpToken: env("OBSIDIAN_MCP_TOKEN") || null,
    semanticMcpUrl: env("OBSIDIAN_SEMANTIC_MCP_URL") || null,
    semanticMcpToken: env("OBSIDIAN_SEMANTIC_MCP_TOKEN") || null,
    lanOnly: bool("LAN_ONLY", false),
    logLevel: env("LOG_LEVEL", "info")!,
    ...overrides,
  };
  return cfg;
}

export function dataPaths(dataDir: string) {
  return {
    db: path.join(dataDir, "transcriber.sqlite"),
    uploads: path.join(dataDir, "uploads"),
    recordings: path.join(dataDir, "recordings"),
    tmp: path.join(dataDir, "tmp"),
    logs: path.join(dataDir, "logs"),
    llm: path.join(dataDir, "llm-sandbox"),
  };
}
