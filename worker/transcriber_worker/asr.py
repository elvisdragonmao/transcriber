"""Qwen3-ASR (Transformers native) over VAD-planned segments, with checkpoints."""

from __future__ import annotations

import json
import time
from typing import Any

from . import audio as audio_io
from .checkpoint import Checkpoint, fingerprint, write_json_atomic
from .models import ModelRegistry, free_cuda, is_oom
from .protocol import TaskContext, WorkerError
from .textnorm import looks_degenerate, parse_vocabulary, to_traditional

LANG_NAMES = {"zh": "Chinese", "en": "English"}


def _load_asr(model_id: str):
    import torch
    from transformers import AutoModelForMultimodalLM, AutoProcessor

    proc = AutoProcessor.from_pretrained(model_id)
    model = AutoModelForMultimodalLM.from_pretrained(model_id, dtype=torch.bfloat16, device_map="cuda:0").eval()
    return proc, model


def build_prompt(vocab: list[str], context: str) -> str | None:
    parts = []
    if vocab:
        parts.append("Vocabulary: " + ", ".join(vocab) + ".")
    if context:
        parts.append("Previous context: " + context)
    return "\n".join(parts) or None


def transcribe_one(proc, model, wav, language: str | None, prompt: str | None, max_new_tokens: int) -> dict[str, Any]:
    import torch

    kw: dict[str, Any] = {}
    if language:
        kw["language"] = language
    if prompt:
        kw["prompt"] = prompt
    inputs = proc.apply_transcription_request(audio=wav, **kw).to(model.device, model.dtype)
    with torch.inference_mode():
        out = model.generate(**inputs, max_new_tokens=max_new_tokens, do_sample=False)
    gen = out[:, inputs["input_ids"].shape[1] :]
    parsed = proc.decode(gen, return_format="parsed")[0]
    raw = proc.decode(gen)[0]
    return {"language": parsed.get("language") or language, "text": (parsed.get("transcription") or "").strip(), "raw": raw}


def run_asr(ctx: TaskContext, p: dict[str, Any], models: ModelRegistry) -> dict[str, Any]:
    with open(p["segments_path"], encoding="utf-8") as f:
        plan = json.load(f)
    segments = plan["segments"]
    model_id = p.get("model", "Qwen/Qwen3-ASR-1.7B-hf")
    lang_hint = LANG_NAMES.get(p.get("language", "auto"))
    vocab = parse_vocabulary(p.get("vocabulary", ""))
    script = p.get("chinese_script", "s2twp")
    ctx_chars = int(p.get("context_chars", 120))
    max_new = int(p.get("max_new_tokens", 512))
    fp = fingerprint({"m": model_id, "l": lang_hint, "v": vocab, "s": script, "c": ctx_chars, "segs": [[s["start_ms"], s["end_ms"]] for s in segments]})
    ck = Checkpoint(p.get("checkpoint_path"), "asr", fp)
    if ck.resumed:
        ctx.log(f"resuming ASR from checkpoint: {ck.resumed}/{len(segments)} segments already done")

    total_ms = sum(s["end_ms"] - s["start_ms"] for s in segments) or 1
    done_ms = sum(s["end_ms"] - s["start_ms"] for s in segments if ck.has(s["idx"]))
    ctx.progress(done_ms / 1000, total_ms / 1000, "s", force=True, segments_done=ck.resumed, segments_total=len(segments))

    proc, model = models.get("asr:" + model_id, lambda: _load_asr(model_id))
    sr = audio_io.SR
    prev_text = ""
    t0 = time.monotonic()
    try:
        for seg in segments:
            idx = seg["idx"]
            if ck.has(idx):
                prev_text = ck.get(idx)["text_raw"]
                continue
            ctx.check()
            wav = audio_io.read_span(p["audio_path"], seg["start_ms"] * sr // 1000, seg["end_ms"] * sr // 1000)
            dur = len(wav) / sr
            context = prev_text[-ctx_chars:] if ctx_chars and prev_text else ""
            attempt = 0
            while True:
                try:
                    r = transcribe_one(proc, model, wav, lang_hint, build_prompt(vocab, context), max_new)
                    break
                except BaseException as e:
                    if is_oom(e) and attempt == 0:
                        attempt += 1
                        models.unload_all(except_="asr:" + model_id)
                        free_cuda()
                        continue
                    if is_oom(e):
                        raise WorkerError("OOM", f"CUDA out of memory in ASR segment {idx}", retryable=True) from e
                    raise
            if looks_degenerate(r["text"], dur) and context:
                # Context can occasionally prime the model into repeating itself: retry without it.
                r = transcribe_one(proc, model, wav, lang_hint, build_prompt(vocab, ""), max_new)
            text_raw = r["text"]
            lang = r["language"] or ""
            # Only CJK runs are converted; English terms and vocabulary entries are left untouched.
            text = to_traditional(text_raw, script, protect=vocab)
            ck.put(
                idx,
                {
                    "idx": idx,
                    "start_ms": seg["start_ms"],
                    "end_ms": seg["end_ms"],
                    "language": lang,
                    "text_raw": text_raw,
                    "text": text,
                    "degenerate": looks_degenerate(text_raw, dur),
                },
            )
            prev_text = text_raw
            done_ms += seg["end_ms"] - seg["start_ms"]
            ctx.progress(done_ms / 1000, total_ms / 1000, "s", segments_done=len(ck.items), segments_total=len(segments))
    except BaseException:
        ck.flush()  # keep finished segments for resume after pause / crash / cancel-with-keep
        raise
    ck.flush()

    results = [ck.get(s["idx"]) for s in segments]
    langs: dict[str, int] = {}
    for r in results:
        if r["language"]:
            langs[r["language"]] = langs.get(r["language"], 0) + (r["end_ms"] - r["start_ms"])
    write_json_atomic(
        p["output_path"],
        {"version": 1, "model": model_id, "language_hint": lang_hint, "vocabulary": vocab, "chinese_script": script, "segments": results, "languages_ms": langs},
    )
    ctx.progress(total_ms / 1000, total_ms / 1000, "s", force=True, segments_done=len(segments), segments_total=len(segments))
    return {
        "output_path": p["output_path"],
        "segments": len(results),
        "languages_ms": langs,
        "elapsed_s": round(time.monotonic() - t0, 1),
        "resumed_segments": ck.resumed,
        "model_version": model_id,
    }
