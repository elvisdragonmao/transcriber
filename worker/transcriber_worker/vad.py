"""Silero VAD (ONNX, CPU) + ASR segment planning."""

from __future__ import annotations

import time
from typing import Any

import numpy as np

from . import audio as audio_io
from .checkpoint import write_json_atomic
from .protocol import TaskContext
from .segmentation import Span, build_segments

_model = None


def _load_model():
    global _model
    if _model is None:
        from silero_vad import load_silero_vad

        _model = load_silero_vad(onnx=True)
    return _model


def run_vad(ctx: TaskContext, p: dict[str, Any]) -> dict[str, Any]:
    import torch
    from silero_vad import get_speech_timestamps

    torch.set_num_threads(max(1, int(p.get("threads", 4))))
    wav = audio_io.load(p["audio_path"])
    sr = audio_io.SR
    total = len(wav)
    model = _load_model()
    t0 = time.monotonic()

    def on_progress(pct: float) -> None:
        # silero reports percentage of processed audio frames
        # VAD has no partial state worth keeping; after a pause it is simply re-run.
        ctx.check()
        ctx.progress(pct / 100.0 * total / sr, total / sr, "s")

    ts = get_speech_timestamps(
        torch.from_numpy(wav),
        model,
        threshold=float(p.get("threshold", 0.4)),
        sampling_rate=sr,
        min_speech_duration_ms=int(p.get("min_speech_ms", 200)),
        min_silence_duration_ms=int(p.get("min_silence_ms", 400)),
        speech_pad_ms=int(p.get("speech_pad_ms", 300)),
        return_seconds=False,
        progress_tracking_callback=on_progress,
    )
    spans = [Span(int(t["start"]), int(t["end"])) for t in ts]
    segs = build_segments(
        spans,
        wav,
        sr,
        total,
        max_len_s=float(p.get("max_segment_s", 28)),
        min_len_s=float(p.get("min_segment_s", 1.0)),
        max_gap_s=float(p.get("max_gap_s", 1.2)),
    )
    speech_samples = sum(s.end - s.start for s in spans)
    result = {
        "version": 1,
        "sample_rate": sr,
        "total_ms": int(total * 1000 / sr),
        "speech_ms": int(speech_samples * 1000 / sr),
        "speech_spans": [[int(s.start * 1000 / sr), int(s.end * 1000 / sr)] for s in spans],
        "segments": [
            {"idx": i, "start_ms": int(s.start * 1000 / sr), "end_ms": int(s.end * 1000 / sr)} for i, s in enumerate(segs)
        ],
        "params": {k: p.get(k) for k in ("threshold", "min_speech_ms", "min_silence_ms", "speech_pad_ms", "max_segment_s")},
        "elapsed_s": round(time.monotonic() - t0, 2),
    }
    write_json_atomic(p["output_path"], result)
    ctx.progress(total / sr, total / sr, "s", force=True)
    return {
        "output_path": p["output_path"],
        "segments": len(segs),
        "speech_ms": result["speech_ms"],
        "total_ms": result["total_ms"],
        "model_version": "silero-vad onnx " + _silero_version(),
    }


def _silero_version() -> str:
    try:
        from importlib.metadata import version

        return version("silero-vad")
    except Exception:
        return "unknown"
