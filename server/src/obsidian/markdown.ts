import { msToClock } from "../lib/util.js";
import { paragraphs, type ExportDoc } from "../transcript/exporters.js";

/** YAML scalar: JSON strings are valid YAML, which makes quoting injection-proof. */
const y = (v: unknown): string => {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(String(v));
};

export function frontmatter(fields: Record<string, unknown>): string {
  const lines = ["---"];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      if (!v.length) lines.push(`${k}: []`);
      else {
        lines.push(`${k}:`);
        for (const item of v) lines.push(`  - ${y(item)}`);
      }
    } else lines.push(`${k}: ${y(v)}`);
  }
  lines.push("---", "");
  return lines.join("\n");
}

/** Untrusted text (model output, transcript) → inert Markdown: no raw HTML, no accidental embeds. */
export function inert(s: string): string {
  return String(s ?? "")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/!\[\[/g, "! [[")
    .replace(/\r/g, "");
}

export function linkTo(stem: string, alias?: string) {
  return alias ? `[[${stem}|${alias}]]` : `[[${stem}]]`;
}

export function durationLabel(ms: number | null): string | null {
  if (!ms) return null;
  return msToClock(ms);
}

export function transcriptMarkdown(
  doc: ExportDoc,
  meta: {
    type: string;
    project: string | null;
    sourceAudio: string;
    created: string;
    tags: string[];
    relatedNotes: string[];
  },
): string {
  const fm = frontmatter({
    title: doc.title,
    date: doc.date,
    type: meta.type,
    project: meta.project,
    speakers: doc.speakers,
    duration: durationLabel(doc.durationMs),
    language: doc.language,
    source_audio: meta.sourceAudio,
    transcript_id: doc.id,
    tags: meta.tags,
    created: meta.created,
    updated: new Date().toISOString(),
  });
  const lines = [fm, `# ${inert(doc.title)}`, ""];
  if (meta.relatedNotes.length) lines.push(`相關筆記：${meta.relatedNotes.map((s) => linkTo(s)).join("、")}`, "");
  lines.push("> 由本機語音辨識自動產生（Qwen3-ASR + Nemotron Diarization）。講者標示為「重疊發言」或「未確定」的段落，歸屬可能不準確。", "");
  for (const p of paragraphs(doc.segments)) {
    const who = p.status === "overlap" ? `${p.speaker}（重疊發言）` : p.status === "uncertain" ? `${p.speaker}（未確定）` : p.speaker;
    lines.push(`**${inert(who)}** \`${msToClock(p.start)}\``, inert(p.text), "");
  }
  return lines.join("\n").trimEnd() + "\n";
}
