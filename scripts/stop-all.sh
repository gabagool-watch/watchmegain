#!/usr/bin/env bash
set -euo pipefail

echo "[stop-all] Killing lag-recorder + worker (if running)..."
pkill -f "tsx src/jobs/lag-recorder.ts" >/dev/null 2>&1 || true
pkill -f "tsx src/jobs/worker.ts" >/dev/null 2>&1 || true
pkill -f "next dev" >/dev/null 2>&1 || true

echo "[stop-all] Done."

