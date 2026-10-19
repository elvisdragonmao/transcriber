from __future__ import annotations

import numpy as np
import soundfile as sf

SR = 16000


def info(path: str) -> tuple[int, int]:
    i = sf.info(path)
    if i.samplerate != SR or i.channels != 1:
        raise ValueError(f"expected 16 kHz mono wav, got {i.samplerate} Hz / {i.channels} ch")
    return i.frames, i.samplerate


def load(path: str) -> np.ndarray:
    data, sr = sf.read(path, dtype="float32", always_2d=False)
    if sr != SR:
        raise ValueError(f"expected {SR} Hz audio, got {sr}")
    if data.ndim > 1:
        data = data.mean(axis=1)
    return np.ascontiguousarray(data)


def read_span(path: str, start: int, end: int) -> np.ndarray:
    with sf.SoundFile(path) as f:
        f.seek(max(0, start))
        data = f.read(max(0, end - start), dtype="float32", always_2d=False)
    if data.ndim > 1:
        data = data.mean(axis=1)
    return np.ascontiguousarray(data)
