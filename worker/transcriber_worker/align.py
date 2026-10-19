"""Qwen3-ForcedAligner word timestamps for each ASR segment."""

from __future__ import annotations

import json
import re
import time
from typing import Any

from . import audio as audio_io
from .checkpoint import Checkpoint, fingerprint, write_json_atomic
from .models import ModelRegistry, free_cuda, is_oom
from .protocol import TaskContext, WorkerError

SUPPORTED = {
    "chinese": "Chinese",
    "english": "English",
    "cantonese": "Cantonese",
    "french": "French",
    "german": "German",
    "italian": "Italian",
    "japanese": "Japanese",
    "korean": "Korean",
    "portuguese": "Portuguese",
    "russian": "Russian",
    "spanish": "Spanish",
}
CJK = re.compile(r"[㐀-鿿豈-﫿]")


def _load_aligner(model_id: str):
    import torch
    from transformers import AutoModelForTokenClassification, AutoProcessor

    proc = AutoProcessor.from_pretrained(model_id)
    model = AutoModelForTokenClassification.from_pretrained(model_id, dtype=torch.bfloat16, device_map="cuda:0").eval()
    return proc, model


def aligner_language(lang: str, text: str) -> str | None:
    key = (lang or "").lower()
    for k, v in SUPPORTED.items():
        if k in key:
            return v
    if CJK.search(text):
        return "Chinese"
    if re.search(r"[A-Za-z]", text):
        return "English"
    return None


def locate_words(text: str, words: list[str]) -> list[tuple[int | None, int | None]]:
    """Map aligner tokens back to character offsets in the displayed text (sequential search)."""
    out: list[tuple[int | None, int | None]] = []
    cursor = 0
    lower = text.lower()
    for w in words:
        if not w:
            out.append((None, None))
            continue
        i = text.find(w, cursor)
        if i < 0:
            i = lower.find(w.lower(), cursor)
        if i < 0 or i - cursor > 40:
            out.append((None, None))
            continue
        out.append((i, i + len(w)))
        cursor = i + len(w)
    return out


def fallback_words(text: str, seg_ms: int) -> list[dict[str, Any]]:
    """Evenly spread tokens when alignment is impossible; marked aligned=False."""
    toks = [(m.group(), m.start(), m.end()) for m in re.finditer(r"[A-Za-z0-9'’-]+|[㐀-鿿豈-﫿]", text)]
    if not toks:
        return []
    step = seg_ms / len(toks)
    return [
        {"t": t, "rs": int(i * step), "re": int((i + 1) * step), "cs": cs, "ce": ce, "aligned": False}
        for i, (t, cs, ce) in enumerate(toks)
    ]


def run_align(ctx: TaskContext, p: dict[str, Any], models: ModelRegistry) -> dict[str, Any]:
    import torch

    with open(p["asr_path"], encoding="utf-8") as f:
        asr = json.load(f)
    segments = [s for s in asr["segments"]]
    model_id = p.get("model", "Qwen/Qwen3-ForcedAligner-0.6B-hf")
    fp = fingerprint({"m": model_id, "segs": [[s["idx"], s["start_ms"], s["text"]] for s in segments]})
    ck = Checkpoint(p.get("checkpoint_path"), "align", fp)
    total = len(segments)
    ctx.progress(len(ck.items), total, "segments", force=True)
    proc, model = models.get("aligner:" + model_id, lambda: _load_aligner(model_id))
    sr = audio_io.SR
    t0 = time.monotonic()
    unaligned = 0
    try:
        for seg in segments:
            idx = seg["idx"]
            if ck.has(idx):
                continue
            ctx.check()
            text = seg["text"]
            seg_ms = seg["end_ms"] - seg["start_ms"]
            lang = aligner_language(seg.get("language", ""), text)
            words: list[dict[str, Any]] = []
            status = "empty"
            if text.strip() and lang:
                wav = audio_io.read_span(p["audio_path"], seg["start_ms"] * sr // 1000, seg["end_ms"] * sr // 1000)
                for attempt in range(2):
                    try:
                        ai, wl = proc.prepare_forced_aligner_inputs(audio=wav, transcript=text, language=lang)
                        ai = ai.to(model.device, model.dtype)
                        with torch.inference_mode():
                            o = model(**ai)
                        ts = proc.decode_forced_alignment(
                            logits=o.logits, input_ids=ai["input_ids"], word_lists=wl, timestamp_token_id=model.config.timestamp_token_id
                        )[0]
                        break
                    except BaseException as e:
                        if is_oom(e) and attempt == 0:
                            models.unload_all(except_="aligner:" + model_id)
                            free_cuda()
                            continue
                        if is_oom(e):
                            raise WorkerError("OOM", f"CUDA out of memory aligning segment {idx}", retryable=True) from e
                        raise
                offsets = locate_words(text, [t["text"] for t in ts])
                last_end = 0
                for t, (cs, ce) in zip(ts, offsets):
                    rs = max(last_end, min(seg_ms, int(round(t["start_time"] * 1000))))
                    re_ = max(rs, min(seg_ms, int(round(t["end_time"] * 1000))))
                    words.append({"t": t["text"], "rs": rs, "re": re_, "cs": cs, "ce": ce, "aligned": True})
                    last_end = rs
                status = "aligned"
            elif text.strip():
                words = fallback_words(text, seg_ms)
                status = "unsupported_language"
                unaligned += 1
            ck.put(idx, {"idx": idx, "status": status, "language": lang, "words": words})
            ctx.progress(len(ck.items), total, "segments")
    except BaseException:
        ck.flush()
        raise
    ck.flush()
    out = [ck.get(s["idx"]) for s in segments]
    write_json_atomic(p["output_path"], {"version": 1, "model": model_id, "segments": out})
    ctx.progress(total, total, "segments", force=True)
    return {
        "output_path": p["output_path"],
        "segments": total,
        "unaligned_segments": unaligned,
        "words": sum(len(s["words"]) for s in out),
        "elapsed_s": round(time.monotonic() - t0, 1),
        "model_version": model_id,
    }
