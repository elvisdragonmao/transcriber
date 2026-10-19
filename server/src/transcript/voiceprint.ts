/** Speaker-embedding helpers and the conservative matching policy. */

export function toBlob(v: number[] | Float32Array): Buffer {
  const f = v instanceof Float32Array ? v : Float32Array.from(v);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}

export function fromBlob(b: Buffer): Float32Array {
  const copy = Buffer.from(b); // ensure alignment
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}

export function normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

export function centroid(vs: Float32Array[]): Float32Array {
  const out = new Float32Array(vs[0].length);
  for (const v of vs) for (let i = 0; i < v.length; i++) out[i] += v[i];
  return normalize(out);
}

export interface KnownSpeaker {
  id: string;
  name: string;
  embeddings: Float32Array[];
}

export interface LocalSpeaker {
  key: number;
  embedding: Float32Array | null;
  cleanMs: number;
  consistency: number | null;
}

export interface MatchPolicy {
  threshold: number;
  minMargin: number;
  suggestBelowBy: number;
  minTotalCleanMs: number;
}

export interface MatchResult {
  key: number;
  speakerId: string | null;
  assignment: "auto" | "suggested" | "unknown";
  score: number | null;
  margin: number | null;
  suggestedId: string | null;
  reason: string;
}

/**
 * Auto-name a local speaker only when (a) it has enough clean speech, (b) the best
 * known speaker clears the threshold, (c) it beats the runner-up by a margin, and
 * (d) no other local speaker in the same recording claimed that person with a
 * higher score. Anything less stays Unknown (optionally with a suggestion).
 */
export function matchSpeakers(locals: LocalSpeaker[], known: KnownSpeaker[], policy: MatchPolicy): MatchResult[] {
  const cents = known.filter((k) => k.embeddings.length).map((k) => ({ ...k, c: centroid(k.embeddings) }));
  const scored = locals.map((l) => {
    if (!l.embedding || l.cleanMs < policy.minTotalCleanMs || !cents.length)
      return { l, ranked: [] as { id: string; s: number }[], why: !l.embedding || l.cleanMs < policy.minTotalCleanMs ? "not enough clean speech" : "no enrolled speakers" };
    const ranked = cents.map((k) => ({ id: k.id, s: cosine(l.embedding!, k.c) })).sort((a, b) => b.s - a.s);
    return { l, ranked, why: "" };
  });

  const results = new Map<number, MatchResult>();
  const candidates = scored
    .filter((x) => x.ranked.length)
    .map((x) => {
      const best = x.ranked[0];
      const margin = best.s - (x.ranked[1]?.s ?? -1);
      return { key: x.l.key, best, margin };
    })
    .sort((a, b) => b.best.s - a.best.s);

  const claimed = new Set<string>();
  for (const c of candidates) {
    const passes = c.best.s >= policy.threshold && c.margin >= policy.minMargin;
    if (passes && !claimed.has(c.best.id)) {
      claimed.add(c.best.id);
      results.set(c.key, { key: c.key, speakerId: c.best.id, assignment: "auto", score: c.best.s, margin: c.margin, suggestedId: null, reason: "above threshold with margin" });
    } else if (c.best.s >= policy.threshold - policy.suggestBelowBy) {
      results.set(c.key, {
        key: c.key,
        speakerId: null,
        assignment: "suggested",
        score: c.best.s,
        margin: c.margin,
        suggestedId: c.best.id,
        reason: claimed.has(c.best.id) ? "best match already used by a stronger speaker" : passes ? "" : c.margin < policy.minMargin ? "too close to another speaker" : "below threshold",
      });
    } else {
      results.set(c.key, { key: c.key, speakerId: null, assignment: "unknown", score: c.best.s, margin: c.margin, suggestedId: null, reason: "below threshold" });
    }
  }
  for (const x of scored)
    if (!results.has(x.l.key))
      results.set(x.l.key, { key: x.l.key, speakerId: null, assignment: "unknown", score: null, margin: null, suggestedId: null, reason: x.why });
  return locals.map((l) => results.get(l.key)!);
}
