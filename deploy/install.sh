#!/usr/bin/env bash
# Production install / upgrade on the GPU host (Ubuntu 24.04, systemd).
# Idempotent: re-run after `git pull` to rebuild and restart.
#
#   ./deploy/install.sh            # deps, build, models, systemd service
#   ./deploy/install.sh --no-models
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"
WITH_MODELS=1
[[ "${1:-}" == "--no-models" ]] && WITH_MODELS=0

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

step "Checking prerequisites"
for c in node pnpm ffmpeg ffprobe nvidia-smi; do command -v "$c" >/dev/null || { echo "missing: $c" >&2; exit 1; }; done
command -v uv >/dev/null || { echo "installing uv (user-level)"; curl -LsSf https://astral.sh/uv/install.sh | sh; }
node -e 'process.exit(+process.versions.node.split(".")[0] >= 22 ? 0 : 1)' || { echo "Node.js >= 22 required" >&2; exit 1; }
nvidia-smi --query-gpu=index,uuid,name,memory.total,compute_cap --format=csv,noheader

step "Python AI worker environment (torch cu132 for Blackwell sm_120 + Ampere sm_86)"
[[ -x worker/.venv/bin/python ]] || uv venv --python 3.12 worker/.venv
uv pip install --python worker/.venv/bin/python --index-strategy unsafe-best-match \
  --extra-index-url https://download.pytorch.org/whl/cu132 \
  "torch==2.12.0+cu132" "transformers==5.20.1" accelerate "nemo-toolkit[asr]==3.0.0" \
  Cython packaging onnxruntime "silero-vad==6.2.3" "opencc-python-reimplemented==0.1.7" soundfile numpy pytest
worker/.venv/bin/python - <<'PY'
import torch
assert torch.cuda.is_available(), "CUDA not available to PyTorch"
for i in range(torch.cuda.device_count()):
    p = torch.cuda.get_device_properties(i)
    print(f"  cuda:{i} {p.name} sm_{p.major}{p.minor} {p.total_memory // 2**20} MiB")
print("  arch list:", torch.cuda.get_arch_list())
PY

if [[ $WITH_MODELS == 1 ]]; then
  step "Downloading models to the Hugging Face cache (public, no token needed)"
  worker/.venv/bin/python scripts/download_models.py
fi

step "Node dependencies and build"
pnpm install --frozen-lockfile 2>/dev/null || pnpm install
pnpm --filter web build
pnpm --filter server build

step "Configuration"
if [[ ! -f .env ]]; then
  cp .env.example .env
  PW=$(head -c 18 /dev/urandom | base64 | tr -d '/+=' | head -c 20)
  sed -i "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=$PW|" .env
  chmod 600 .env
  echo "  created .env (admin password: grep ADMIN_PASSWORD .env); edit PUBLIC_ORIGIN and the optional Obsidian MCP settings"
fi
mkdir -p data/logs
set -a; . ./.env; set +a
node server/dist/cli.js migrate

step "systemd service"
sed -e "s|@USER@|$(id -un)|g" -e "s|@ROOT@|$ROOT|g" -e "s|@HOME@|$HOME|g" deploy/transcriber.service \
  | sudo tee /etc/systemd/system/transcriber.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable transcriber.service
sudo systemctl restart transcriber.service
for i in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:${PORT:-8000}/api/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "http://127.0.0.1:${PORT:-8000}/api/health" && echo
systemctl --no-pager --lines=0 status transcriber.service || true
echo
echo "Done. Local: http://127.0.0.1:${PORT:-8000}  Public (WARP): ${PUBLIC_ORIGIN:-}"
