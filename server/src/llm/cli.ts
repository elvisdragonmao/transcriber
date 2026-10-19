import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { CancelledError } from "../lib/errors.js";
import type { StageSignal } from "../workers/pool.js";

export interface CliRun {
  stdout: string;
  stderr: string;
  code: number | null;
  durationMs: number;
}

export class CliError extends Error {
  constructor(
    public code: string,
    message: string,
    public retryable = false,
  ) {
    super(message);
  }
}

/**
 * Run a CLI with an argument array (no shell), in its own process group, with a
 * minimal environment, a hard timeout, an output cap, and cooperative cancellation.
 */
export function runCli(
  bin: string,
  args: string[],
  opts: { stdin?: string; cwd: string; env: Record<string, string>; timeoutMs: number; signal?: StageSignal; maxOutput?: number },
): Promise<CliRun> {
  const t0 = Date.now();
  const max = opts.maxOutput ?? 20 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    } catch (e: any) {
      return reject(new CliError("NOT_INSTALLED", `${bin}: ${e.message}`));
    }
    let out = "";
    let err = "";
    let killedFor: string | null = null;
    const killGroup = (why: string) => {
      if (killedFor) return;
      killedFor = why;
      try {
        process.kill(-child.pid!, "SIGTERM");
      } catch {
        /* already gone */
      }
      setTimeout(() => {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          /* gone */
        }
      }, 5000);
    };
    const timer = setTimeout(() => killGroup("timeout"), opts.timeoutMs);
    opts.signal?.on(() => killGroup(opts.signal!.reason ?? "cancel"));
    child.stdout.on("data", (d: Buffer) => {
      out += d;
      if (out.length > max) killGroup("output_limit");
    });
    child.stderr.on("data", (d: Buffer) => {
      err = (err + d).slice(-20000);
    });
    child.on("error", (e: any) => {
      clearTimeout(timer);
      reject(new CliError(e.code === "ENOENT" ? "NOT_INSTALLED" : "SPAWN_FAILED", `${path.basename(bin)}: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (killedFor === "cancel" || killedFor === "pause") return reject(new CancelledError());
      if (killedFor === "timeout") return reject(new CliError("TIMEOUT", `${path.basename(bin)} timed out after ${Math.round(opts.timeoutMs / 1000)} s`, true));
      if (killedFor === "output_limit") return reject(new CliError("OUTPUT_LIMIT", "CLI output exceeded the size limit"));
      resolve({ stdout: out, stderr: err, code, durationMs: Date.now() - t0 });
    });
    if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
    else child.stdin.end();
  });
}

/** Environment passed to LLM CLIs: enough to find their auth, nothing else (no server secrets). */
export function cliEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
  const keep = ["PATH", "LANG", "LC_ALL", "TZ", "USER", "LOGNAME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"];
  const env: Record<string, string> = { HOME: home, NO_COLOR: "1", CI: "1" };
  for (const k of keep) if (process.env[k]) env[k] = process.env[k]!;
  env.PATH = [path.join(home, ".local", "bin"), path.join(home, ".npm-global", "bin"), env.PATH ?? "/usr/bin:/bin"].join(":");
  return { ...env, ...extra };
}

/** Fresh empty working directory per run, so the CLI has nothing to read even if a tool slipped through. */
export async function sandboxDir(base: string): Promise<string> {
  await fsp.mkdir(base, { recursive: true, mode: 0o700 });
  return fsp.mkdtemp(path.join(base, "run-"));
}
