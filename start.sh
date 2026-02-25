#!/bin/bash
# OhMyOpenClaw dedicated startup script
# Launches an independent opencode server on a configurable port and runs the bot
# Default port is 4097; port 4096 is reserved for development/TUI use

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Load env
set -a && source .env && set +a

# Make port configurable via OPENCODE_SERVER_PORT env var (default 4097)
PORT=${OPENCODE_SERVER_PORT:-4097}

echo "[start] Starting dedicated opencode server on port $PORT..."
opencode serve --port $PORT &
OPENCODE_PID=$!
echo "[start] opencode server PID: $OPENCODE_PID"

# Wait for server to be ready
for i in $(seq 1 20); do
  if curl -s "http://127.0.0.1:$PORT/session/status" > /dev/null 2>&1; then
    echo "[start] opencode server ready"
    break
  fi
  echo "[start] Waiting for server... ($i/20)"
  sleep 1
done

echo "[start] Starting opencode-feishu bot..."
bun run src/index.ts &
BOT_PID=$!
echo "[start] bot PID: $BOT_PID"

# Trap signals to clean up both processes
cleanup() {
  echo "[start] Shutting down..."
  kill $BOT_PID 2>/dev/null
  kill $OPENCODE_PID 2>/dev/null
  wait
  echo "[start] Done"
}
trap cleanup SIGTERM SIGINT

wait $BOT_PID
cleanup
