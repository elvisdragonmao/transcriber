#!/usr/bin/env bash
# Development: API (tsx watch) + Vite dev server with /api proxy. One terminal.
#   MOCK_WORKER=1 ./scripts/dev.sh   # without GPUs
set -euo pipefail
cd "$(dirname "$0")/.."
trap 'kill 0' EXIT
(cd server && npx tsx watch src/index.ts) &
(cd web && npx vite --host 127.0.0.1) &
wait
