#!/usr/bin/env python3
"""Drive the real worker processes over the JSON-lines protocol (same as the Node
scheduler does) for one audio file. Used for model acceptance testing.

usage: worker_e2e.py <wav16k> <outdir> --asr-gpu GPU-... --diar-gpu GPU-... [--language auto]
"""

import argparse
import json
import os
import subprocess
import sys
import time
import uuid

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PY = os.path.join(ROOT, "worker", ".venv", "bin", "python")


class Lane:
    def __init__(self, lane: str, device: str) -> None:
        env = dict(os.environ, CUDA_VISIBLE_DEVICES=device, CUDA_DEVICE_ORDER="PCI_BUS_ID", PYTHONUNBUFFERED="1")
        self.p = subprocess.Popen(
            [PY, "-m", "transcriber_worker", "--lane", lane],
            cwd=os.path.join(ROOT, "worker"),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=open(f"/tmp/worker-{lane}.log", "w"),
            text=True,
            env=env,
        )
        ready = json.loads(self.p.stdout.readline())
        assert ready["type"] == "ready", ready
        self.lane = lane

    def call(self, op: str, params: dict) -> dict:
        cid = str(uuid.uuid4())
        self.p.stdin.write(json.dumps({"type": "call", "id": cid, "op": op, "params": params}) + "\n")
        self.p.stdin.flush()
        t0 = time.time()
        last = 0.0
        while True:
            line = self.p.stdout.readline()
            if not line:
                raise RuntimeError(f"{self.lane} worker died")
            m = json.loads(line)
            if m["type"] == "progress" and time.time() - last > 5:
                last = time.time()
                print(f"  [{self.lane}:{op}] {m['done']:.1f}/{m['total']} {m['unit']}", flush=True)
            elif m["type"] == "log":
                print(f"  [{self.lane}:{op}] log: {m['message']}")
            elif m["type"] in ("result", "error"):
                print(f"  [{self.lane}:{op}] {m['type']} in {time.time() - t0:.1f}s")
                if m["type"] == "error":
                    raise RuntimeError(m)
                return m["result"]

    def close(self):
        self.p.stdin.write('{"type":"shutdown"}\n')
        self.p.stdin.flush()
        self.p.wait(timeout=30)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("wav")
    ap.add_argument("out")
    ap.add_argument("--asr-gpu", required=True)
    ap.add_argument("--diar-gpu", required=True)
    ap.add_argument("--language", default="auto")
    ap.add_argument("--vocabulary", default="")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    o = lambda n: os.path.join(a.out, n)
    cpu, gasr, gdiar = Lane("cpu", ""), Lane("gpu-asr", a.asr_gpu), Lane("gpu-diar", a.diar_gpu)
    try:
        print("health", json.dumps(gasr.call("health", {}).get("device")), json.dumps(gdiar.call("health", {}).get("device")))
        r = cpu.call("vad", {"audio_path": a.wav, "output_path": o("vad.json")})
        print("vad", r)
        r = gdiar.call("diarize", {"audio_path": a.wav, "output_path": o("diar.json"), "device": "cuda"})
        print("diarize", r)
        r = gasr.call("asr", {"audio_path": a.wav, "segments_path": o("vad.json"), "output_path": o("asr.json"), "checkpoint_path": o("asr.ckpt.json"), "language": a.language, "vocabulary": a.vocabulary})
        print("asr", r)
        r = gasr.call("align", {"audio_path": a.wav, "asr_path": o("asr.json"), "output_path": o("align.json"), "checkpoint_path": o("align.ckpt.json")})
        print("align", r)
        print("health after", json.dumps(gasr.call("health", {}).get("device")))
        diar = json.load(open(o("diar.json")))
        spans = {}
        for t in diar["turns"]:
            spans.setdefault(str(t["speaker"]), []).append([t["start_ms"], t["end_ms"]])
        spans = {k: sorted(v, key=lambda x: x[0] - x[1])[:8] for k, v in spans.items()}
        r = cpu.call("embed", {"audio_path": a.wav, "speakers": spans, "output_path": o("embed.json")})
        print("embed", r)
        emb = json.load(open(o("embed.json")))["speakers"]
        import numpy as np

        keys = [k for k in emb if emb[k]["embedding"]]
        M = np.array([emb[k]["embedding"] for k in keys])
        print("speaker cross-similarity:\n", keys, "\n", np.round(M @ M.T, 2))
    finally:
        for l in (cpu, gasr, gdiar):
            l.close()


if __name__ == "__main__":
    sys.exit(main())
