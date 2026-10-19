"""Turn VAD speech spans into ASR segments.

ASR segments are an *audio* concept (what the model sees at once) and are unrelated
to HTTP upload chunks. All times are absolute sample offsets into the original
recording timeline, so nothing downstream ever needs to renumber anything.

Rules:
- neighbouring spans are merged while the gap is short and the result stays under
  `max_len`, so sentences are not cut at every breath;
- a single span longer than `max_len` is split at the quietest frame inside a window
  before the limit (a natural pause), never at a fixed offset if avoidable;
- spans shorter than `min_len` that cannot be merged are kept (padded) so short
  answers like "對" or "yes" are not lost.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

import numpy as np


@dataclass
class Span:
    start: int  # samples
    end: int


def frame_energy(audio: np.ndarray, sr: int, frame_ms: int = 20) -> np.ndarray:
    hop = max(1, int(sr * frame_ms / 1000))
    n = len(audio) // hop
    if n == 0:
        return np.zeros(0, dtype=np.float32)
    frames = audio[: n * hop].reshape(n, hop).astype(np.float32)
    return np.sqrt(np.mean(frames * frames, axis=1) + 1e-12)


def _split_long(span: Span, energy: np.ndarray, sr: int, max_len: int, frame: int, search: int) -> list[Span]:
    out: list[Span] = []
    start = span.start
    while span.end - start > max_len:
        hi = start + max_len
        lo = max(start + max_len - search, start + max_len // 2)
        f_lo, f_hi = lo // frame, max(lo // frame + 1, hi // frame)
        window = energy[f_lo:f_hi]
        cut = (f_lo + int(np.argmin(window))) * frame if len(window) else hi
        cut = min(max(cut, start + sr), hi)  # at least 1 s of progress
        out.append(Span(start, cut))
        start = cut
    out.append(Span(start, span.end))
    return out


def build_segments(
    spans: Sequence[Span],
    audio: np.ndarray,
    sr: int,
    total_samples: int,
    max_len_s: float = 28.0,
    min_len_s: float = 1.0,
    max_gap_s: float = 1.2,
    frame_ms: int = 20,
) -> list[Span]:
    if not spans:
        return []
    max_len = int(max_len_s * sr)
    min_len = int(min_len_s * sr)
    max_gap = int(max_gap_s * sr)
    frame = int(sr * frame_ms / 1000)
    energy = frame_energy(audio, sr, frame_ms)

    pieces: list[Span] = []
    for s in sorted(spans, key=lambda x: x.start):
        s = Span(max(0, s.start), min(total_samples, s.end))
        if s.end <= s.start:
            continue
        pieces.extend(_split_long(s, energy, sr, max_len, frame, search=int(6 * sr)))

    merged: list[Span] = []
    for p in pieces:
        if merged:
            last = merged[-1]
            gap = p.start - last.end
            if gap <= max_gap and p.end - last.start <= max_len:
                last.end = max(last.end, p.end)
                continue
            # tiny leftovers stick to the previous segment when the result still fits
            if p.end - p.start < min_len and gap <= max_gap * 2 and p.end - last.start <= max_len * 1.15:
                last.end = max(last.end, p.end)
                continue
        merged.append(Span(p.start, p.end))

    # enforce a minimum duration by symmetric padding (bounded by neighbours)
    for i, m in enumerate(merged):
        dur = m.end - m.start
        if dur >= min_len:
            continue
        need = (min_len - dur) // 2
        lo_bound = merged[i - 1].end if i > 0 else 0
        hi_bound = merged[i + 1].start if i + 1 < len(merged) else total_samples
        m.start = max(lo_bound, m.start - need)
        m.end = min(hi_bound, m.end + need)
    return merged
