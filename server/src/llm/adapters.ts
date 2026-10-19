import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { CliError, cliEnv, runCli, sandboxDir } from "./cli.js";
import type { StageSignal } from "../workers/pool.js";

export interface AdapterStatus {
  provider: "claude" | "codex";
  installed: boolean;
  version: string | null;
  loggedIn: boolean;
  account: string | null;
  detail: string;
  efforts: string[];
}

export interface GenerateArgs {
  system: string;
  prompt: string;
  schema: object;
  model: string;
  effort: string;
  timeoutMs: number;
  maxBudgetUsd: number;
  signal?: StageSignal;
}

export interface GenerateResult {
  output: any;
  costUsd: number | null;
  durationMs: number;
  resolvedModel: string | null;
}

export interface LlmAdapter {
  readonly id: "claude" | "codex";
  status(): Promise<AdapterStatus>;
  generate(a: GenerateArgs): Promise<GenerateResult>;
}

const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const CODEX_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"];

export class ClaudeAdapter implements LlmAdapter {
  readonly id = "claude" as const;
  constructor(
    private bin: string,
    private home: string,
    private sandboxBase: string,
  ) {}

  async status(): Promise<AdapterStatus> {
    const base: AdapterStatus = { provider: "claude", installed: false, version: null, loggedIn: false, account: null, detail: "", efforts: CLAUDE_EFFORTS };
    if (!fs.existsSync(this.bin)) return { ...base, detail: `Claude Code CLI not found at ${this.bin}` };
    try {
      const v = await runCli(this.bin, ["--version"], { cwd: this.home, env: cliEnv(this.home), timeoutMs: 20_000 });
      base.installed = true;
      base.version = v.stdout.trim().split("\n")[0];
      const a = await runCli(this.bin, ["auth", "status"], { cwd: this.home, env: cliEnv(this.home), timeoutMs: 20_000 });
      const j = JSON.parse(a.stdout);
      base.loggedIn = !!j.loggedIn;
      base.account = j.loggedIn ? `${j.authMethod ?? ""}${j.subscriptionType ? ` (${j.subscriptionType})` : ""}` : null;
      base.detail = j.loggedIn ? "Logged in" : "Not logged in — run `claude auth login` on the server";
    } catch (e: any) {
      base.detail = String(e.message ?? e);
    }
    return base;
  }

  async generate(a: GenerateArgs): Promise<GenerateResult> {
    const cwd = await sandboxDir(this.sandboxBase);
    try {
      if (!CLAUDE_EFFORTS.includes(a.effort)) throw new CliError("BAD_OPTION", `Unsupported effort ${a.effort}`);
      const args = [
        "-p",
        "--output-format", "json",
        "--json-schema", JSON.stringify(a.schema),
        "--model", a.model,
        "--effort", a.effort,
        // least privilege: no tools, no MCP servers, no user/project customisations, nothing persisted
        "--tools", "",
        "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
        "--safe-mode",
        "--disable-slash-commands",
        "--no-session-persistence",
        "--permission-mode", "dontAsk",
        "--permission-prompts", "none",
        "--max-budget-usd", String(a.maxBudgetUsd),
        "--system-prompt", a.system,
      ];
      const r = await runCli(this.bin, args, { stdin: a.prompt, cwd, env: cliEnv(this.home), timeoutMs: a.timeoutMs, signal: a.signal });
      let j: any;
      try {
        j = JSON.parse(r.stdout);
      } catch {
        throw new CliError("BAD_OUTPUT", `Claude CLI returned non-JSON output (exit ${r.code}): ${r.stderr.slice(-300) || r.stdout.slice(0, 300)}`, true);
      }
      if (j.is_error || j.subtype !== "success") {
        const msg = String(j.result ?? j.subtype ?? "error").slice(0, 500);
        const budget = /budget/i.test(msg) || j.subtype === "error_max_budget_usd";
        throw new CliError(budget ? "BUDGET" : "CLI_ERROR", `Claude CLI: ${msg}`, !budget);
      }
      const output = j.structured_output ?? (() => {
        try {
          return JSON.parse(j.result);
        } catch {
          return null;
        }
      })();
      if (!output || typeof output !== "object") throw new CliError("BAD_OUTPUT", "Claude CLI did not return structured output", true);
      const resolved = Object.keys(j.modelUsage ?? {})[0] ?? null;
      return { output, costUsd: typeof j.total_cost_usd === "number" ? j.total_cost_usd : null, durationMs: r.durationMs, resolvedModel: resolved };
    } finally {
      await fsp.rm(cwd, { recursive: true, force: true });
    }
  }
}

export class CodexAdapter implements LlmAdapter {
  readonly id = "codex" as const;
  constructor(
    private bin: string,
    private home: string,
    private sandboxBase: string,
  ) {}

  async status(): Promise<AdapterStatus> {
    const base: AdapterStatus = { provider: "codex", installed: false, version: null, loggedIn: false, account: null, detail: "", efforts: CODEX_EFFORTS };
    if (!fs.existsSync(this.bin)) return { ...base, detail: `Codex CLI not found at ${this.bin} (npm i -g @openai/codex)` };
    try {
      const v = await runCli(this.bin, ["--version"], { cwd: this.home, env: cliEnv(this.home), timeoutMs: 20_000 });
      base.installed = true;
      base.version = v.stdout.trim();
      const s = await runCli(this.bin, ["login", "status"], { cwd: this.home, env: cliEnv(this.home), timeoutMs: 20_000 });
      const text = `${s.stdout}\n${s.stderr}`.trim();
      base.loggedIn = /logged in/i.test(text) && !/not logged in/i.test(text);
      base.account = base.loggedIn ? text.split("\n")[0] : null;
      base.detail = base.loggedIn ? text.split("\n")[0] : "Not logged in — run `codex login` on the server";
    } catch (e: any) {
      base.detail = String(e.message ?? e);
    }
    return base;
  }

  async generate(a: GenerateArgs): Promise<GenerateResult> {
    const cwd = await sandboxDir(this.sandboxBase);
    try {
      if (!CODEX_EFFORTS.includes(a.effort)) throw new CliError("BAD_OPTION", `Unsupported effort ${a.effort}`);
      const schemaFile = path.join(cwd, "schema.json");
      const outFile = path.join(cwd, "last-message.json");
      await fsp.writeFile(schemaFile, JSON.stringify(a.schema));
      const args = [
        "exec",
        "--sandbox", "read-only",
        "--skip-git-repo-check",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--color", "never",
        "-C", cwd,
        "-c", `model_reasoning_effort="${a.effort}"`,
        "-c", 'approval_policy="never"',
        "-c", 'shell_environment_policy.inherit="none"',
        "--output-schema", schemaFile,
        "-o", outFile,
      ];
      if (a.model) args.push("-m", a.model);
      args.push("-");
      const prompt = `${a.system}\n\n${a.prompt}`;
      const r = await runCli(this.bin, args, { stdin: prompt, cwd, env: cliEnv(this.home), timeoutMs: a.timeoutMs, signal: a.signal });
      if (r.code !== 0) {
        const tail = (r.stderr || r.stdout).slice(-500);
        const auth = /not logged in|login|unauthori[sz]ed|401/i.test(tail);
        throw new CliError(auth ? "NOT_LOGGED_IN" : "CLI_ERROR", `Codex CLI exited ${r.code}: ${tail}`, !auth);
      }
      let output: any;
      try {
        output = JSON.parse(await fsp.readFile(outFile, "utf8"));
      } catch {
        throw new CliError("BAD_OUTPUT", "Codex CLI did not produce JSON matching the schema", true);
      }
      return { output, costUsd: null, durationMs: r.durationMs, resolvedModel: a.model || null };
    } finally {
      await fsp.rm(cwd, { recursive: true, force: true });
    }
  }
}
