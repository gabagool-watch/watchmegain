#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

mkdir -p logs

echo "[start-all] Starting Postgres + Redis via docker compose..."
if command -v docker >/dev/null 2>&1; then
  docker compose up -d postgres redis >/dev/null
else
  echo "[start-all] ERROR: docker not found. Install Docker Desktop or run DB manually."
  exit 1
fi

echo "[start-all] Waiting for Postgres to become ready..."
for i in {1..60}; do
  if docker exec pnltracker-db pg_isready -U postgres >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! docker exec pnltracker-db pg_isready -U postgres >/dev/null 2>&1; then
  echo "[start-all] ERROR: Postgres did not become ready."
  exit 1
fi

if [[ "${DB_INIT:-0}" == "1" ]]; then
  echo "[start-all] DB_INIT=1 → running prisma db:push + db:seed..."
  npm run -s db:push
  npm run -s db:seed
fi

# Provide reasonable defaults if not set in .env / shell.
export BINANCE_SAMPLE_MS="${BINANCE_SAMPLE_MS:-100}"
export CHAINLINK_POLL_MS="${CHAINLINK_POLL_MS:-250}"

echo "[start-all] Starting lag-recorder..."
npm run -s lag-recorder > logs/lag-recorder.log 2>&1 &
LAG_PID=$!

echo "[start-all] Starting worker..."
npm run -s worker > logs/worker.log 2>&1 &
WORKER_PID=$!

cleanup() {
  echo
  echo "[start-all] Stopping background jobs..."
  kill "$LAG_PID" "$WORKER_PID" >/dev/null 2>&1 || true
  wait "$LAG_PID" "$WORKER_PID" >/dev/null 2>&1 || true
  echo "[start-all] Bye."
}
trap cleanup EXIT INT TERM

echo "[start-all] Starting Next dev server (Ctrl+C to stop everything)..."
exec npm run -s dev

