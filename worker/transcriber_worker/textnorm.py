"""Chinese script conversion that leaves English, numbers and user vocabulary intact."""

from __future__ import annotations

import re
from functools import lru_cache

CJK = re.compile(r"[㐀-䶿一-鿿豈-﫿]")
_PLACEHOLDER_BASE = 0xE000  # Unicode private use area: OpenCC never touches it


@lru_cache(maxsize=4)
def _converter(mode: str):
    from opencc import OpenCC

    return OpenCC(mode)


def parse_vocabulary(vocab: str) -> list[str]:
    items = re.split(r"[,\n;、，；]+", vocab or "")
    seen: list[str] = []
    for it in items:
        it = it.strip()
        if it and it not in seen:
            seen.append(it[:80])
    return seen[:200]


def to_traditional(text: str, mode: str = "s2twp", protect: list[str] | None = None) -> str:
    if mode == "none" or not text or not CJK.search(text):
        return text
    protect = sorted({p for p in (protect or []) if CJK.search(p)}, key=len, reverse=True)
    mapping: dict[str, str] = {}
    for i, term in enumerate(protect[:500]):
        ph = chr(_PLACEHOLDER_BASE + i)
        if term in text:
            text = text.replace(term, ph)
            mapping[ph] = term
    out = _converter(mode).convert(text)
    for ph, term in mapping.items():
        out = out.replace(ph, term)
    return out


def looks_degenerate(text: str, duration_s: float) -> bool:
    """Detect runaway generation (loops) relative to audio length."""
    if not text:
        return False
    cjk = len(CJK.findall(text))
    words = len(re.findall(r"[A-Za-z']+", text))
    rate = (cjk + words * 1.5) / max(duration_s, 0.5)
    if rate > 14:
        return True
    # same 6+ char chunk repeated many times
    m = re.search(r"(.{6,30}?)\1{4,}", text)
    return m is not None
