import { useMemo } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";

/** Render model-generated Markdown safely: parsed, then sanitised (no scripts, no event handlers). */
export function Markdown({ source }: { source: string }) {
  const html = useMemo(() => {
    const body = source.replace(/^---\n[\s\S]*?\n---\n/, ""); // frontmatter is shown separately
    const raw = marked.parse(body.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, a, b) => `**${b ?? a}**`), { async: false }) as string;
    return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true }, FORBID_TAGS: ["style", "iframe", "form", "img"], FORBID_ATTR: ["style"] });
  }, [source]);
  return <div className="prose-note text-[15px]" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function frontmatterOf(source: string): Record<string, string> {
  const m = source.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([a-z_]+):\s*(.*)$/);
    if (kv && kv[2]) out[kv[1]] = kv[2].replace(/^"|"$/g, "");
  }
  return out;
}
