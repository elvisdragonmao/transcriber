import type { DB } from "../db/index.js";
import type { SettingsStore } from "../settings.js";
import { AppError, nowIso } from "../lib/util.js";
import { ClaudeAdapter, CodexAdapter, type AdapterStatus, type GenerateArgs, type GenerateResult, type LlmAdapter } from "./adapters.js";
import { CliError } from "./cli.js";

export class LlmService {
  private adapters: Record<"claude" | "codex", LlmAdapter>;
  private statusCache: { at: number; data: AdapterStatus[] } | null = null;

  constructor(
    private db: DB,
    private settings: SettingsStore,
    opts: { claudeBin: string; codexBin: string; home: string; sandbox: string },
    adapters?: Partial<Record<"claude" | "codex", LlmAdapter>>,
  ) {
    this.adapters = {
      claude: adapters?.claude ?? new ClaudeAdapter(opts.claudeBin, opts.home, opts.sandbox),
      codex: adapters?.codex ?? new CodexAdapter(opts.codexBin, opts.home, opts.sandbox),
    };
  }

  async status(force = false): Promise<AdapterStatus[]> {
    if (!force && this.statusCache && Date.now() - this.statusCache.at < 60_000) return this.statusCache.data;
    const data = await Promise.all([this.adapters.claude.status(), this.adapters.codex.status()]);
    this.statusCache = { at: Date.now(), data };
    return data;
  }

  callsToday(): number {
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    return (this.db.prepare("SELECT COUNT(*) AS n FROM llm_usage WHERE created_at >= ?").get(since.toISOString()) as any).n;
  }

  /** Resolve provider/model/effort from job options with settings as defaults; reject unknown combinations. */
  resolve(opts: { provider?: string; model?: string; effort?: string }) {
    const s = this.settings.get().llm;
    const provider = (opts.provider ?? s.provider) as "claude" | "codex";
    if (!["claude", "codex"].includes(provider)) throw new AppError(400, "bad_provider", "Unknown provider");
    const p = s[provider];
    const model = opts.model ?? p.model;
    if (provider === "claude" && !model) throw new AppError(400, "bad_model", "No Claude model configured");
    if (opts.model && !p.models.includes(opts.model) && opts.model !== p.model)
      throw new AppError(400, "bad_model", `Model ${opts.model} is not in the configured list for ${provider}`);
    return { provider, model, effort: opts.effort ?? p.effort };
  }

  async generate(provider: "claude" | "codex", args: Omit<GenerateArgs, "timeoutMs" | "maxBudgetUsd">, purpose: string): Promise<GenerateResult> {
    const s = this.settings.get().llm;
    if (this.callsToday() >= s.dailyCallLimit)
      throw new CliError("DAILY_LIMIT", `Daily LLM call limit (${s.dailyCallLimit}) reached; raise it in Settings if intended`);
    const t0 = Date.now();
    try {
      const r = await this.adapters[provider].generate({ ...args, timeoutMs: s.timeoutSec * 1000, maxBudgetUsd: s.maxBudgetUsd });
      this.log(provider, args.model, purpose, r.costUsd, r.durationMs, true);
      return r;
    } catch (e) {
      this.log(provider, args.model, purpose, null, Date.now() - t0, false);
      throw e;
    }
  }

  private log(provider: string, model: string, purpose: string, cost: number | null, ms: number, ok: boolean) {
    this.db
      .prepare("INSERT INTO llm_usage (provider, model, purpose, cost_usd, duration_ms, ok, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(provider, model, purpose, cost, ms, ok ? 1 : 0, nowIso());
  }

  /** Tiny real call to prove a provider/model/effort combination works; records it as verified. */
  async test(provider: "claude" | "codex", model: string, effort: string) {
    const r = await this.generate(
      provider,
      {
        system: "Reply using the schema only.",
        prompt: "Return ok=true and echo the word 'pong'.",
        schema: { type: "object", additionalProperties: false, properties: { ok: { type: "boolean" }, word: { type: "string" } }, required: ["ok", "word"] },
        model,
        effort,
      },
      "test",
    );
    const verified = { ...this.settings.get().llm.verifiedModels, [`${provider}:${model}`]: nowIso() };
    this.settings.update({ llm: { verifiedModels: verified } });
    return { ok: r.output?.ok === true, output: r.output, costUsd: r.costUsd, durationMs: r.durationMs, resolvedModel: r.resolvedModel };
  }

  usage(days = 30) {
    return this.db
      .prepare(
        `SELECT substr(created_at, 1, 10) AS day, provider, COUNT(*) AS calls, SUM(ok) AS ok, ROUND(COALESCE(SUM(cost_usd), 0), 4) AS cost_usd
         FROM llm_usage WHERE created_at >= ? GROUP BY day, provider ORDER BY day DESC`,
      )
      .all(new Date(Date.now() - days * 86400_000).toISOString());
  }
}
