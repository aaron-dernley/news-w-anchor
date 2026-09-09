#!/bin/bash
# Brings up `swamp serve` for this repo just long enough to run the
# morning-broadcast workflow through it, then tears it down — avoids the
# idle RSS cost of a persistent daemon while still executing via serve.
#
# Invoked by the swamp-workflow-news-w-anchor.service systemd unit on a
# daily timer. SWAMP_SERVE_URL in the shell profile points at a different
# repo's serve, so every call here passes --server explicitly.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT=9094
INSTANCE=anchor
WORKFLOW=morning-broadcast
SERVER="ws://127.0.0.1:${PORT}"

cd "$REPO_DIR"
env -u SWAMP_SERVE_URL swamp serve --repo-dir "$REPO_DIR" --port "$PORT" \
  --host 127.0.0.1 --no-schedule --no-telemetry \
  >/tmp/news-w-anchor-serve.log 2>&1 &
SERVE_PID=$!
trap 'kill "$SERVE_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 20); do
  if curl -s -o /dev/null "http://127.0.0.1:${PORT}/" 2>/dev/null; then
    break
  fi
  sleep 0.5
done

swamp workflow run "$WORKFLOW" --server "$SERVER"

# Export a Prometheus textfile for the Fun Stuff Grafana dashboard, derived
# from the model's own data. Written atomically (tmp + mv) since
# node_exporter's textfile collector may be reading concurrently.
PROM_DIR=/var/lib/prometheus/node-exporter
if [ -d "$PROM_DIR" ] && [ -w "$PROM_DIR" ]; then
  PROM_TMP="$(mktemp "${PROM_DIR}/.news-w-anchor.prom.XXXXXX")"
  {
    swamp data get "$INSTANCE" ledger --server "$SERVER" --json 2>/dev/null || true
    echo '---'
    swamp data get "$INSTANCE" last-run --server "$SERVER" --json 2>/dev/null || true
  } | python3 "${REPO_DIR}/prom-export.py" > "$PROM_TMP"
  chmod 644 "$PROM_TMP"
  mv "$PROM_TMP" "${PROM_DIR}/news-w-anchor.prom"
fi
