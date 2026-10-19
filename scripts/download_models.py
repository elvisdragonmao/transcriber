#!/usr/bin/env python3
"""Pre-download every model the worker uses into the Hugging Face cache and print the
resolved revisions, so the first job does not stall on a multi-GB download."""

from huggingface_hub import snapshot_download

MODELS = [
    ("Qwen/Qwen3-ASR-1.7B-hf", None),
    ("Qwen/Qwen3-ForcedAligner-0.6B-hf", None),
    ("nvidia/Nemotron-3-Diarization", ["*.json", "*.safetensors", "README.md"]),
    ("nvidia/speakerverification_en_titanet_large", ["*.nemo", "README.md"]),
]

for repo, patterns in MODELS:
    path = snapshot_download(repo, allow_patterns=patterns)
    print(f"{repo:48s} {path.rsplit('/', 1)[-1][:12]}  {path}")

# Silero VAD ships inside the pip package (ONNX); importing verifies it is present.
from silero_vad import load_silero_vad  # noqa: E402

load_silero_vad(onnx=True)
print("snakers4/silero-vad (onnx, bundled with the silero-vad package)")
