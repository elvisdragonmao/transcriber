import { msToClock } from "../lib/util.js";

export interface ExportSegment {
  start: number;
  end: number;
  speaker: string;
  status: string;
  text: string;
}

export interface ExportDoc {
  id: string;
  title: string;
  date: string | null;
  durationMs: number | null;
  language: string | null;
  speakers: string[];
  segments: ExportSegment[];
  model: Record<string, unknown>;
}

const speakerLabel = (s: ExportSegment) => (s.status === "overlap" ? `${s.speaker}（重疊發言）` : s.status === "uncertain" ? `${s.speaker}（未確定）` : s.speaker);

/** Consecutive segments by the same speaker become one paragraph. */
export function paragraphs(segs: ExportSegment[], maxGapMs = 4000) {
  const out: { start: number; end: number; speaker: string; status: string; text: string }[] = [];
  for (const s of segs) {
    const last = out[out.length - 1];
    if (last && last.speaker === s.speaker && last.status === s.status && s.start - last.end <= maxGapMs) {
      last.text += /[㐀-鿿]$/.test(last.text) || /^[㐀-鿿]/.test(s.text) ? s.text : ` ${s.text}`;
      last.end = s.end;
    } else out.push({ ...s });
  }
  return out;
}

export function toTxt(d: ExportDoc): string {
  const lines = [d.title];
  if (d.date) lines.push(`日期：${d.date}`);
  lines.push("");
  for (const p of paragraphs(d.segments)) lines.push(`[${msToClock(p.start)}] ${speakerLabel(p)}：${p.text}`, "");
  return lines.join("\n").trimEnd() + "\n";
}

export function toMarkdownBody(d: ExportDoc): string {
  const lines: string[] = [];
  for (const p of paragraphs(d.segments)) lines.push(`**${speakerLabel(p)}** \`${msToClock(p.start)}\``, "", p.text, "");
  return lines.join("\n").trimEnd() + "\n";
}

export function toMarkdown(d: ExportDoc): string {
  return `# ${d.title}\n\n${toMarkdownBody(d)}`;
}

export function toJson(d: ExportDoc): string {
  return JSON.stringify(d, null, 2);
}

function cues(d: ExportDoc) {
  // subtitles: keep cues short (< 7 s, < 84 chars), never merge across speakers
  const out: ExportSegment[] = [];
  for (const s of d.segments) {
    if (s.end - s.start <= 7000 && s.text.length <= 84) {
      out.push(s);
      continue;
    }
    const parts = Math.max(Math.ceil((s.end - s.start) / 7000), Math.ceil(s.text.length / 84));
    const step = (s.end - s.start) / parts;
    const chars = Math.ceil(s.text.length / parts);
    for (let i = 0; i < parts; i++)
      out.push({ ...s, start: Math.round(s.start + i * step), end: Math.round(s.start + (i + 1) * step), text: s.text.slice(i * chars, (i + 1) * chars) });
  }
  return out.filter((c) => c.text.trim());
}

export function toSrt(d: ExportDoc): string {
  return (
    cues(d)
      .map((c, i) => `${i + 1}\n${msToClock(c.start, true, ",")} --> ${msToClock(Math.max(c.end, c.start + 300), true, ",")}\n${c.speaker}: ${c.text.trim()}\n`)
      .join("\n") + "\n"
  );
}

export function toVtt(d: ExportDoc): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return (
    "WEBVTT\n\n" +
    cues(d)
      .map((c) => `${msToClock(c.start, true)} --> ${msToClock(Math.max(c.end, c.start + 300), true)}\n<v ${esc(c.speaker)}>${esc(c.text.trim())}\n`)
      .join("\n")
  );
}
