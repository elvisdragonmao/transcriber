import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { assignWordSpeakers, cleanSpans, mergeTranscript, sentenceRanges, type MergedWord } from "../src/transcript/merge.js";
import { matchSpeakers } from "../src/transcript/voiceprint.js";
import { validateVaultPath, sanitizeFileStem, fillTemplate } from "../src/obsidian/paths.js";
import { toSrt, toVtt } from "../src/transcript/exporters.js";
import { ClaudeAdapter, CodexAdapter } from "../src/llm/adapters.js";
import { frontmatter } from "../src/obsidian/markdown.js";
import { tmpDir } from "./helpers.js";
import { StageSignal } from "../src/workers/pool.js";

const word = (text: string, start: number, end: number): MergedWord => ({ asrIdx: 0, idx: 0, text, start, end, relStart: start, relEnd: end, speaker: null, overlapWith: [], aligned: true });

describe("speaker assignment uses real time overlap", () => {
  const turns = [
    { speaker: 0, start_ms: 0, end_ms: 5000 },
    { speaker: 1, start_ms: 4800, end_ms: 9000 },
    { speaker: 0, start_ms: 7000, end_ms: 8000 }, // overlap region 7–8 s
  ];
  it("assigns by maximal overlap, not by segment start", () => {
    const ws = [word("a", 100, 400), word("b", 4850, 5600), word("c", 6000, 6500), word("d", 7100, 7900), word("e", 20000, 20100)];
    assignWordSpeakers(ws, turns);
    expect(ws[0].speaker).toBe(0);
    expect(ws[1].speaker).toBe(1); // starts in speaker 0's turn but mostly speaker 1
    expect(ws[2].speaker).toBe(1);
    expect(ws[3].overlapWith.length).toBe(1); // both speakers active
    expect(ws[4].speaker).toBe(null); // far from any turn → unknown, not guessed
  });

  it("splits a sentence where the speaker changes and flags overlap / uncertainty", () => {
    const asr = [{ idx: 0, start_ms: 0, end_ms: 9000, text_raw: "", text: "我們先開始吧。好的我來報告進度。" }];
    const chars = [..."我們先開始吧好的我來報告進度"];
    const words = chars.map((c, i) => {
      const s = i < 6 ? 500 + i * 600 : 5000 + (i - 6) * 450;
      const cs = asr[0].text.indexOf(c, i < 6 ? 0 : 7);
      return { t: c, rs: s, re: s + 300, cs, ce: cs + 1, aligned: true };
    });
    const { segments } = mergeTranscript(asr, [{ idx: 0, status: "aligned", words }], turns.slice(0, 2));
    expect(segments.map((s) => [s.text, s.speaker, s.status])).toEqual([
      ["我們先開始吧。", 0, "assigned"],
      ["好的我來報告進度。", 1, "assigned"],
    ]);
    const unk = mergeTranscript(asr, [{ idx: 0, status: "aligned", words }], []);
    expect(unk.segments.every((s) => s.status === "uncertain" && s.speaker === null)).toBe(true);
  });

  it("sentence ranges keep punctuation and split English on periods", () => {
    const t = "Hello there. How are you? 我很好！";
    expect(sentenceRanges(t).map(([a, b]) => t.slice(a, b))).toEqual(["Hello there.", "How are you?", "我很好！"]);
  });

  it("clean voiceprint spans exclude overlapped speech", () => {
    const c = cleanSpans(turns, 1000, 60000);
    expect(c.get(0)).toEqual([[0, 4800]]); // 7–8 s overlaps speaker 1 and is excluded; 4.8–5.0 too
    expect(c.get(1)).toEqual([[5000, 7000], [8000, 9000]]);
  });
});

describe("voiceprint matching is conservative", () => {
  const v = (...xs: number[]) => Float32Array.from(xs);
  const known = [
    { id: "a", name: "A", embeddings: [v(1, 0, 0)] },
    { id: "b", name: "B", embeddings: [v(0.9, 0.436, 0)] },
  ];
  const policy = { threshold: 0.75, minMargin: 0.1, suggestBelowBy: 0.12, minTotalCleanMs: 5000 };
  it("auto-names only above threshold with margin", () => {
    const [r] = matchSpeakers([{ key: 0, embedding: v(0, 0, 1), cleanMs: 9000, consistency: 1 }], known, policy);
    expect(r.assignment).toBe("unknown");
    const [r2] = matchSpeakers([{ key: 0, embedding: v(0.95, 0.2, 0), cleanMs: 9000, consistency: 1 }], known, policy);
    expect(r2.assignment).toBe("suggested"); // close to both A and B → not enough margin
    const [r3] = matchSpeakers([{ key: 0, embedding: v(1, -0.3, 0), cleanMs: 9000, consistency: 1 }], known, policy);
    expect(r3).toMatchObject({ assignment: "auto", speakerId: "a" });
  });
  it("needs enough clean speech and never gives one person to two speakers", () => {
    const [short] = matchSpeakers([{ key: 0, embedding: v(1, 0, 0), cleanMs: 1000, consistency: 1 }], known, policy);
    expect(short.assignment).toBe("unknown");
    const res = matchSpeakers(
      [
        { key: 0, embedding: v(1, -0.3, 0), cleanMs: 9000, consistency: 1 },
        { key: 1, embedding: v(1, -0.25, 0), cleanMs: 9000, consistency: 1 },
      ],
      known,
      policy,
    );
    expect(res.filter((x) => x.speakerId === "a").length).toBe(1);
  });
});

describe("vault path safety", () => {
  const roots = ["50 🏳️‍⚧️ Trans"];
  it.each([
    "../x.md",
    "50 🏳️‍⚧️ Trans/../10 💻 Projects/x.md",
    "/etc/passwd.md",
    "C:/x.md",
    "50 🏳️‍⚧️ Trans/.obsidian/app.md",
    "50 🏳️‍⚧️ Trans/a\u0000b.md",
    "10 💻 Projects/x.md",
    "50 🏳️‍⚧️ Trans/x.sh",
    "50 🏳️‍⚧️ Transfer/x.md",
  ])("rejects %s", (p) => {
    expect(() => validateVaultPath(p, roots)).toThrow();
  });
  it("accepts normal paths", () => {
    expect(validateVaultPath("50 🏳️‍⚧️ Trans/逐字稿/261019 會議 逐字稿.md", roots)).toBeTruthy();
  });
  it("sanitises names and fills templates", () => {
    expect(sanitizeFileStem('a/b\\c:d*e?"f<g>h|i#j^k[l]m ../..')).toBe("a b c d e f g h i j k l m");
    expect(fillTemplate("{yymmdd} {title} 逐字稿", { title: "會議", date: new Date(2026, 9, 19) })).toBe("261019 會議 逐字稿");
  });
  it("frontmatter cannot be broken by hostile values", () => {
    const fm = frontmatter({ title: 'x"\n---\nevil: true' });
    expect(fm.split("\n").filter((l) => l === "---").length).toBe(2);
  });
});

describe("subtitle exporters", () => {
  const doc = { id: "x", title: "t", date: null, durationMs: 1, language: null, speakers: ["A"], model: {}, segments: [{ start: 1500, end: 3200, speaker: "A", status: "assigned", text: "Hello <b>&" }] };
  it("srt", () => expect(toSrt(doc)).toBe("1\n00:00:01,500 --> 00:00:03,200\nA: Hello <b>&\n\n"));
  it("vtt escapes markup", () => expect(toVtt(doc)).toContain("<v A>Hello &lt;b&gt;&amp;"));
});

describe("CLI adapters", () => {
  it("claude runs with tools disabled, args array, minimal env, empty sandbox cwd", async () => {
    const dir = tmpDir("fakecli-");
    const bin = path.join(dir, "claude");
    fs.writeFileSync(
      bin,
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/args"\npwd > "${dir}/cwd"\nenv > "${dir}/env"\ncat > "${dir}/stdin"\necho '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.01,"structured_output":{"ok":true},"modelUsage":{"claude-x":{}}}'\n`,
      { mode: 0o755 },
    );
    process.env.OBSIDIAN_MCP_TOKEN = "super-secret";
    const a = new ClaudeAdapter(bin, dir, path.join(dir, "sb"));
    const r = await a.generate({ system: "sys", prompt: "$(rm -rf /) `id`", schema: { type: "object" }, model: "sonnet", effort: "low", timeoutMs: 10000, maxBudgetUsd: 1 });
    expect(r.output).toEqual({ ok: true });
    const args = fs.readFileSync(`${dir}/args`, "utf8").split("\n");
    expect(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2)).toEqual(["--tools", ""]);
    for (const f of ["--strict-mcp-config", "--safe-mode", "--no-session-persistence", "-p"]) expect(args).toContain(f);
    expect(fs.readFileSync(`${dir}/stdin`, "utf8")).toBe("$(rm -rf /) `id`"); // passed as data, never through a shell
    expect(fs.readFileSync(`${dir}/env`, "utf8")).not.toContain("super-secret");
    expect(fs.readFileSync(`${dir}/cwd`, "utf8").trim().startsWith(path.join(dir, "sb"))).toBe(true);
    expect(fs.readdirSync(path.join(dir, "sb"))).toEqual([]); // sandbox cleaned up
  });

  it("times out and kills a hung CLI; cancellation stops it", async () => {
    const dir = tmpDir("fakecli-");
    const bin = path.join(dir, "claude");
    fs.writeFileSync(bin, "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
    const a = new ClaudeAdapter(bin, dir, path.join(dir, "sb"));
    await expect(a.generate({ system: "", prompt: "", schema: {}, model: "m", effort: "low", timeoutMs: 300, maxBudgetUsd: 1 })).rejects.toMatchObject({ code: "TIMEOUT" });
    const sig = new StageSignal();
    setTimeout(() => sig.request("cancel"), 200);
    await expect(a.generate({ system: "", prompt: "", schema: {}, model: "m", effort: "low", timeoutMs: 10000, maxBudgetUsd: 1, signal: sig })).rejects.toThrow(/cancelled/);
  });

  it("codex reports not installed", async () => {
    const s = await new CodexAdapter("/nope/codex", "/tmp", "/tmp/sb").status();
    expect(s).toMatchObject({ installed: false, loggedIn: false });
  });
});

describe("language-aware voiceprint threshold", () => {
  it("uses the detected language's threshold", async () => {
    const { thresholdFor } = await import("../src/speakers/match.js");
    const s = { thresholdZh: 0.78, thresholdEn: 0.72, thresholdOther: 0.8 } as any;
    expect(thresholdFor("Chinese", s)).toBe(0.78);
    expect(thresholdFor("English", s)).toBe(0.72);
    expect(thresholdFor(null, s)).toBe(0.8);
  });
});
