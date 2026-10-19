"""TitaNet-Large speaker embeddings on CPU.

The embedder is behind a tiny interface (`Embedder`) so another speaker model can be
added later without touching the scheduler or the matching logic.
"""

from __future__ import annotations

import glob
import os
import time
from typing import Any, Protocol

import numpy as np

from . import audio as audio_io
from .checkpoint import write_json_atomic
from .models import ModelRegistry
from .protocol import TaskContext

EDGE_TRIM_MS = 150
MIN_SPAN_MS = 800
MAX_SPAN_MS = 10_000


class Embedder(Protocol):
    name: str
    dim: int

    def embed(self, wav: np.ndarray) -> np.ndarray: ...


class TitaNetEmbedder:
    dim = 192

    def __init__(self, model_id: str) -> None:
        import torch
        from huggingface_hub import snapshot_download
        from nemo.collections.asr.models import EncDecSpeakerLabelModel

        self.name = model_id
        path = snapshot_download(model_id, allow_patterns=["*.nemo"])
        nemo = glob.glob(os.path.join(path, "*.nemo"))[0]
        self.model = EncDecSpeakerLabelModel.restore_from(nemo, map_location="cpu").eval()
        self._torch = torch

    def embed(self, wav: np.ndarray) -> np.ndarray:
        with self._torch.inference_mode():
            e, _ = self.model.infer_segment(wav)
        v = e.squeeze().detach().cpu().numpy().astype(np.float32)
        n = np.linalg.norm(v)
        return v / n if n > 0 else v


def _windows(start_ms: int, end_ms: int) -> list[tuple[int, int]]:
    s, e = start_ms + EDGE_TRIM_MS, end_ms - EDGE_TRIM_MS
    out = []
    while e - s >= MIN_SPAN_MS:
        w_end = min(e, s + MAX_SPAN_MS)
        if e - w_end < MIN_SPAN_MS:
            w_end = e
        out.append((s, w_end))
        s = w_end
    return out


def run_embed(ctx: TaskContext, p: dict[str, Any], models: ModelRegistry) -> dict[str, Any]:
    """params.speakers: {"<key>": [[start_ms, end_ms], ...]} → normalised mean embedding per key."""
    import torch

    torch.set_num_threads(max(1, int(p.get("threads", 4))))
    model_id = p.get("model", "nvidia/speakerverification_en_titanet_large")
    emb: TitaNetEmbedder = models.get("titanet:" + model_id, lambda: TitaNetEmbedder(model_id))
    plan = {k: [w for a, b in spans for w in _windows(int(a), int(b))] for k, spans in p["speakers"].items()}
    total = sum(len(v) for v in plan.values())
    done = 0
    sr = audio_io.SR
    t0 = time.monotonic()
    ctx.progress(0, total, "spans", force=True)
    out: dict[str, Any] = {}
    for key, windows in plan.items():
        vecs, used = [], 0
        for a, b in windows:
            ctx.check()
            wav = audio_io.read_span(p["audio_path"], a * sr // 1000, b * sr // 1000)
            if len(wav) >= MIN_SPAN_MS * sr // 1000:
                vecs.append(emb.embed(wav))
                used += b - a
            done += 1
            ctx.progress(done, total, "spans")
        if not vecs:
            out[key] = {"embedding": None, "used_ms": 0, "spans": 0, "consistency": None}
            continue
        M = np.stack(vecs)
        centroid = M.mean(axis=0)
        centroid /= np.linalg.norm(centroid) or 1
        consistency = float(np.mean(M @ centroid))
        out[key] = {"embedding": centroid.round(6).tolist(), "used_ms": used, "spans": len(vecs), "consistency": round(consistency, 4)}
    result = {"version": 1, "model": model_id, "dim": emb.dim, "speakers": out, "elapsed_s": round(time.monotonic() - t0, 2)}
    if p.get("output_path"):
        write_json_atomic(p["output_path"], result)
    ctx.progress(total, total, "spans", force=True)
    return {"output_path": p.get("output_path"), "model_version": model_id, "dim": emb.dim, "speakers": out if not p.get("output_path") else None, "spans": total}
