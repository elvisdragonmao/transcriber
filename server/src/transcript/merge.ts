/**
 * Merge ASR text, forced-alignment word timings and diarization turns, all on the same
 * absolute timeline (milliseconds from the start of the original recording).
 *
 * Speaker assignment is computed from real time overlap between each word and the
 * diarization turns (never from a segment's start timestamp). Words that fall into
 * overlapping speech or into regions no turn covers are flagged, and a display segment
 * whose words are dominated by such words is marked `overlap` / `uncertain` instead of
 * being forced onto one speaker.
 */

export interface AsrSeg {
  idx: number;
  start_ms: number;
  end_ms: number;
  language?: string;
  text_raw: string;
  text: string;
}
export interface AlignWord {
  t: string;
  rs: number;
  re: number;
  cs: number | null;
  ce: number | null;
  aligned: boolean;
}
export interface AlignSeg {
  idx: number;
  status: string;
  words: AlignWord[];
}
export interface Turn {
  speaker: number;
  start_ms: number;
  end_ms: number;
}

export interface MergedWord {
  asrIdx: number;
  idx: number;
  text: string;
  start: number;
  end: number;
  relStart: number;
  relEnd: number;
  speaker: number | null;
  overlapWith: number[];
  aligned: boolean;
}

export type SpeakerStatus = "assigned" | "overlap" | "uncertain";

export interface MergedSegment {
  asrIdx: number;
  start: number;
  end: number;
  text: string;
  speaker: number | null;
  status: SpeakerStatus;
  overlapSpeakers: number[];
  words: MergedWord[];
}

const SENTENCE_END = /[。！？!?…]+["'」』）)]*|\.(?=\s|$)["')]*|;(?=\s)|；/g;
const NEAR_MS = 300;

/** Character ranges of sentences inside `text` (punctuation stays with its sentence). */
export function sentenceRanges(text: string, maxChars = 120): [number, number][] {
  const out: [number, number][] = [];
  let start = 0;
  SENTENCE_END.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SENTENCE_END.exec(text))) {
    const end = m.index + m[0].length;
    if (end > start) out.push([start, end]);
    start = end;
  }
  if (start < text.length) out.push([start, text.length]);
  // split overly long runs at commas so the viewer stays readable
  const refined: [number, number][] = [];
  for (const [a, b] of out) {
    if (b - a <= maxChars) {
      refined.push([a, b]);
      continue;
    }
    let s = a;
    const re = /[，,、：:]/g;
    re.lastIndex = a;
    let c: RegExpExecArray | null;
    while ((c = re.exec(text)) && c.index < b) {
      if (c.index + 1 - s >= maxChars * 0.5) {
        refined.push([s, c.index + 1]);
        s = c.index + 1;
      }
    }
    if (s < b) refined.push([s, b]);
  }
  return refined
    .map(([a, b]) => {
      while (a < b && /\s/.test(text[a])) a++;
      return [a, b] as [number, number];
    })
    .filter(([a, b]) => b > a);
}

/** Per-speaker overlap (ms) of [s, e) with the turns. `turns` must be sorted by start. */
export function overlapBySpeaker(turns: Turn[], s: number, e: number, startHint = 0): { map: Map<number, number>; hint: number } {
  const map = new Map<number, number>();
  let i = startHint;
  while (i > 0 && turns[i - 1].end_ms > s) i--;
  while (i < turns.length && turns[i].end_ms <= s - 30_000) i++;
  const hint = i;
  for (; i < turns.length && turns[i].start_ms < e; i++) {
    const t = turns[i];
    const o = Math.min(e, t.end_ms) - Math.max(s, t.start_ms);
    if (o > 0) map.set(t.speaker, (map.get(t.speaker) ?? 0) + o);
  }
  return { map, hint };
}

function nearestSpeaker(turns: Turn[], s: number, e: number): number | null {
  let best: number | null = null;
  let bestD = NEAR_MS + 1;
  for (const t of turns) {
    if (t.start_ms > e + NEAR_MS) break;
    const d = t.end_ms < s ? s - t.end_ms : t.start_ms > e ? t.start_ms - e : 0;
    if (d < bestD) {
      bestD = d;
      best = t.speaker;
    }
  }
  return best;
}

export function assignWordSpeakers(words: MergedWord[], turnsIn: Turn[]) {
  const turns = [...turnsIn].sort((a, b) => a.start_ms - b.start_ms);
  let hint = 0;
  for (const w of words) {
    let s = w.start;
    let e = w.end;
    if (e - s < 80) {
      const mid = (s + e) / 2;
      s = mid - 40;
      e = mid + 40;
    }
    const r = overlapBySpeaker(turns, s, e, hint);
    hint = r.hint;
    const ranked = [...r.map.entries()].sort((a, b) => b[1] - a[1]);
    if (!ranked.length) {
      w.speaker = nearestSpeaker(turns.slice(Math.max(0, hint - 5)), s, e);
      w.overlapWith = [];
      continue;
    }
    w.speaker = ranked[0][0];
    const dur = e - s;
    w.overlapWith = ranked.slice(1).filter(([, o]) => o >= dur * 0.5).map(([k]) => k);
  }
}

export function mergeTranscript(asr: AsrSeg[], align: AlignSeg[], turns: Turn[]): { words: MergedWord[]; segments: MergedSegment[] } {
  const alignByIdx = new Map(align.map((a) => [a.idx, a]));
  const allWords: MergedWord[] = [];
  const segments: MergedSegment[] = [];

  for (const seg of [...asr].sort((a, b) => a.start_ms - b.start_ms)) {
    const text = seg.text ?? "";
    if (!text.trim()) continue;
    const al = alignByIdx.get(seg.idx);
    const segLen = seg.end_ms - seg.start_ms;
    const words: MergedWord[] = (al?.words ?? []).map((w, i) => ({
      asrIdx: seg.idx,
      idx: i,
      text: w.t,
      start: seg.start_ms + Math.max(0, Math.min(segLen, w.rs)),
      end: seg.start_ms + Math.max(0, Math.min(segLen, w.re)),
      relStart: w.rs,
      relEnd: w.re,
      speaker: null,
      overlapWith: [],
      aligned: w.aligned,
      _cs: w.cs,
    })) as (MergedWord & { _cs: number | null })[];
    assignWordSpeakers(words, turns);
    allWords.push(...words);

    // place words into sentence ranges by character offset (fall back to order)
    const ranges = sentenceRanges(text);
    const buckets: (MergedWord & { _cs: number | null })[][] = ranges.map(() => []);
    let r = 0;
    for (const w of words as (MergedWord & { _cs: number | null })[]) {
      if (w._cs !== null && w._cs !== undefined) {
        while (r < ranges.length - 1 && w._cs >= ranges[r][1]) r++;
      }
      buckets[r]?.push(w);
    }

    ranges.forEach(([a, b], ri) => {
      const ws = buckets[ri];
      const sentence = text.slice(a, b).trim();
      if (!sentence) return;
      // split a sentence where the speaker genuinely changes (runs of >= 2 words / 600 ms)
      const runs = speakerRuns(ws);
      if (runs.length <= 1 || ws.some((w) => w._cs === null || w._cs === undefined)) {
        segments.push(buildSegment(seg, sentence, ws, a, b, ranges.length));
        return;
      }
      let cursor = a;
      runs.forEach((run, k) => {
        const end = k === runs.length - 1 ? b : (runs[k + 1][0]._cs as number);
        const part = text.slice(cursor, end).trim();
        if (part) segments.push(buildSegment(seg, part, run, cursor, end, ranges.length));
        cursor = end;
      });
    });
  }
  for (const w of allWords) delete (w as any)._cs;
  segments.sort((x, y) => x.start - y.start || x.asrIdx - y.asrIdx);
  return { words: allWords, segments };
}

function speakerRuns<W extends MergedWord>(ws: W[]): W[][] {
  const runs: W[][] = [];
  for (const w of ws) {
    const last = runs[runs.length - 1];
    if (last && (w.speaker === null || last[0].speaker === w.speaker || last[0].speaker === null)) last.push(w);
    else runs.push([w]);
  }
  // absorb short flips into the previous run
  const solid: W[][] = [];
  for (const run of runs) {
    const dur = run[run.length - 1].end - run[0].start;
    const prev = solid[solid.length - 1];
    if (prev && (run.length < 2 || dur < 600)) prev.push(...run);
    else solid.push([...run]);
  }
  return solid;
}

function buildSegment(seg: AsrSeg, text: string, ws: MergedWord[], a: number, b: number, nRanges: number): MergedSegment {
  const timed = ws.filter((w) => w.end >= w.start);
  let start: number;
  let end: number;
  if (timed.length) {
    start = Math.min(...timed.map((w) => w.start));
    end = Math.max(...timed.map((w) => w.end));
  } else {
    // no word timings: interpolate by character position within the ASR segment
    const len = Math.max(1, seg.text.length);
    start = seg.start_ms + Math.round(((seg.end_ms - seg.start_ms) * a) / len);
    end = seg.start_ms + Math.round(((seg.end_ms - seg.start_ms) * b) / len);
    if (nRanges === 1) {
      start = seg.start_ms;
      end = seg.end_ms;
    }
  }
  const dur = new Map<number, number>();
  let overlapMs = 0;
  let unknownMs = 0;
  const overl = new Set<number>();
  let totalMs = 0;
  for (const w of ws) {
    const d = Math.max(40, w.end - w.start);
    totalMs += d;
    if (w.speaker === null) unknownMs += d;
    else dur.set(w.speaker, (dur.get(w.speaker) ?? 0) + d);
    if (w.overlapWith.length) {
      overlapMs += d;
      overl.add(w.speaker!);
      w.overlapWith.forEach((s) => overl.add(s));
    }
  }
  const ranked = [...dur.entries()].sort((x, y) => y[1] - x[1]);
  let speaker: number | null = ranked[0]?.[0] ?? null;
  let status: SpeakerStatus = "assigned";
  if (!totalMs || speaker === null) status = "uncertain";
  else if (overlapMs / totalMs >= 0.3) status = "overlap";
  else if (ranked[0][1] / totalMs < 0.6 || unknownMs / totalMs > 0.4) status = "uncertain";
  if (status === "uncertain" && ranked[0] && ranked[0][1] / totalMs < 0.5) speaker = null;
  return {
    asrIdx: seg.idx,
    start,
    end: Math.max(end, start),
    text,
    speaker,
    status,
    overlapSpeakers: status === "overlap" ? [...overl].filter((x) => x !== null).sort() : [],
    words: ws,
  };
}

/** Non-overlapping, sufficiently long speech per speaker — the best material for voiceprints. */
export function cleanSpans(turnsIn: Turn[], minMs: number, maxTotalMs: number): Map<number, [number, number][]> {
  const turns = [...turnsIn].sort((a, b) => a.start_ms - b.start_ms);
  const out = new Map<number, [number, number][]>();
  for (const t of turns) {
    let pieces: [number, number][] = [[t.start_ms, t.end_ms]];
    for (const o of turns) {
      if (o === t || o.speaker === t.speaker || o.end_ms <= t.start_ms || o.start_ms >= t.end_ms) continue;
      pieces = pieces.flatMap(([a, b]) => {
        if (o.end_ms <= a || o.start_ms >= b) return [[a, b] as [number, number]];
        const res: [number, number][] = [];
        if (o.start_ms > a) res.push([a, o.start_ms]);
        if (o.end_ms < b) res.push([o.end_ms, b]);
        return res;
      });
    }
    for (const p of pieces) if (p[1] - p[0] >= minMs) (out.get(t.speaker) ?? out.set(t.speaker, []).get(t.speaker)!).push(p);
  }
  for (const [k, spans] of out) {
    spans.sort((x, y) => y[1] - y[0] - (x[1] - x[0]));
    const picked: [number, number][] = [];
    let total = 0;
    for (const s of spans) {
      if (total >= maxTotalMs) break;
      const take = Math.min(s[1] - s[0], maxTotalMs - total);
      picked.push([s[0], s[0] + take]);
      total += take;
    }
    out.set(k, picked);
  }
  return out;
}

export function speechMsBySpeaker(turns: Turn[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const t of turns) m.set(t.speaker, (m.get(t.speaker) ?? 0) + (t.end_ms - t.start_ms));
  return m;
}
