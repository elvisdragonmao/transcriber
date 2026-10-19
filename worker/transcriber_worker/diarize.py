"""Nemotron-3-Diarization via its Transformers-native implementation.

The whole recording is streamed chunk by chunk through the model's official
Arrival-Order Speaker Cache, so speaker identities stay consistent across the full
timeline regardless of how ASR segments were cut. The chunk geometry defaults to the
model card's offline preset (chunk 340 + right context 40 encoder frames = 30.4 s).
"""

from __future__ import annotations

import time
from typing import Any

from . import audio as audio_io
from .checkpoint import write_json_atomic
from .models import ModelRegistry, free_cuda, is_oom
from .protocol import TaskContext, WorkerError


def _load(model_id: str, device: str):
    import torch
    from transformers import AutoModelForAudioFrameClassification

    model = AutoModelForAudioFrameClassification.from_pretrained(model_id, dtype=torch.float32).to(device).eval()
    return model


def _processor(model_id: str, chunk_len: int, right_ctx: int):
    from transformers import AutoProcessor

    return AutoProcessor.from_pretrained(model_id, streaming_modes={"offline_chunked": (chunk_len, right_ctx)}, streaming_mode="offline_chunked")


def run_diarize(ctx: TaskContext, p: dict[str, Any], models: ModelRegistry) -> dict[str, Any]:
    import torch

    model_id = p.get("model", "nvidia/Nemotron-3-Diarization")
    device = "cuda:0" if p.get("device", "cuda") == "cuda" else "cpu"
    if device == "cpu":
        torch.set_num_threads(max(1, int(p.get("threads", 6))))
    try:
        model = models.get(f"diar:{model_id}:{device}", lambda: _load(model_id, device))
    except BaseException as e:
        if is_oom(e):
            raise WorkerError("OOM", "CUDA out of memory loading the diarization model", retryable=True) from e
        if device != "cpu" and ("no kernel image" in str(e) or "CUDA" in str(e)):
            raise WorkerError("DEVICE_UNSUPPORTED", f"Diarization GPU unusable: {e}", retryable=False) from e
        raise
    cfg = model.config
    processor = _processor(model_id, int(p.get("chunk_len", getattr(cfg, "chunk_length", 340))), int(p.get("right_context", getattr(cfg, "chunk_right_context", 40))))

    wav = audio_io.load(p["audio_path"])
    sr = audio_io.SR
    total_s = len(wav) / sr
    t0 = time.monotonic()

    def chunks():
        yield 0, processor(wav[: processor.num_samples_first_audio_chunk], sampling_rate=sr, is_streaming=True, is_first_audio_chunk=True)
        mel = processor.num_mel_frames_per_step
        start = processor.audio_chunk_start(mel)
        while (end := start + processor.num_samples_per_audio_chunk) <= wav.shape[0]:
            yield start, processor(wav[start:end], sampling_rate=sr, is_streaming=True, is_first_audio_chunk=False)
            mel += processor.num_mel_frames_per_step
            start = processor.audio_chunk_start(mel)
        yield start, processor(wav[start:], sampling_rate=sr, is_streaming=True, is_first_audio_chunk=False, is_last_audio_chunk=True)

    cache = None
    logits = []
    try:
        with torch.inference_mode():
            for start, inp in chunks():
                # No resumable state: a pause or cancel aborts and the stage is re-run (it is fast).
                ctx.check()
                inp = inp.to(device, dtype=model.dtype)
                out = model(**inp, speaker_cache=cache)
                logits.append(out.logits.float().cpu())
                cache = out.speaker_cache
                ctx.progress(min(total_s, start / sr), total_s, "s")
    except BaseException as e:
        cache = None
        logits = []
        free_cuda()
        if is_oom(e):
            raise WorkerError("OOM", "CUDA out of memory during diarization", retryable=True) from e
        raise
    finally:
        cache = None
    L = torch.cat(logits, dim=1)
    segs = processor.extract_speaker_dict(L)[0]
    max_spk = int(p.get("max_speakers", 8))
    turns = [
        {"speaker": int(s["Speaker"]), "start_ms": int(round(s["Start"] * 1000)), "end_ms": int(round(s["End"] * 1000))}
        for s in segs
        if int(s["Speaker"]) < max_spk and s["End"] > s["Start"]
    ]
    turns.sort(key=lambda t: (t["start_ms"], t["speaker"]))
    speakers = sorted({t["speaker"] for t in turns})
    elapsed = time.monotonic() - t0
    write_json_atomic(
        p["output_path"],
        {"version": 1, "model": model_id, "device": device, "turns": turns, "speakers": speakers, "total_ms": int(total_s * 1000), "elapsed_s": round(elapsed, 2)},
    )
    ctx.progress(total_s, total_s, "s", force=True)
    del L, logits
    free_cuda()
    return {
        "output_path": p["output_path"],
        "speakers": len(speakers),
        "turns": len(turns),
        "device": device,
        "elapsed_s": round(elapsed, 1),
        "rtfx": round(total_s / max(elapsed, 1e-3), 1),
        "model_version": f"{model_id} (transformers, chunked streaming w/ speaker cache)",
    }
