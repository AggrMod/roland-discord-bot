#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PM2_PROCESS_NAME="${PM2_PROCESS_NAME:-guildpilot}"
PM2_RESTART_THRESHOLD="${PM2_RESTART_THRESHOLD:-10}"
WEB_PORT="${WEB_PORT:-3000}"
HEALTHCHECK_URL="${HEALTHCHECK_URL:-http://127.0.0.1:${WEB_PORT}/health}"
DB_PATH="${DB_PATH:-$REPO_ROOT/database/guildpilot.db}"

if ! command -v pm2 >/dev/null 2>&1; then
  echo "FAIL: pm2 is not installed or not on PATH"
  exit 1
fi

pm2_json="$(pm2 jlist 2>/dev/null || true)"
if [ -z "$pm2_json" ]; then
  echo "FAIL: unable to read pm2 process list"
  exit 1
fi

pm2_tmp="$(mktemp)"
health_tmp="$(mktemp)"
trap 'rm -f "$pm2_tmp" "$health_tmp"' EXIT
printf '%s' "$pm2_json" > "$pm2_tmp"

if ! process_info="$(python3 -c 'import json, sys
name = sys.argv[1]
path = sys.argv[2]
with open(path, "r", encoding="utf-8") as handle:
    data = json.load(handle)
matches = [proc for proc in data if proc.get("name") == name]
if not matches:
    sys.exit(2)
proc = matches[0]
pm2_env = proc.get("pm2_env") or {}
status = pm2_env.get("status") or "unknown"
restart_count = int(pm2_env.get("restart_time") or 0)
print(f"{status}|{restart_count}")' "$PM2_PROCESS_NAME" "$pm2_tmp")"; then
  echo "FAIL: PM2 process '$PM2_PROCESS_NAME' not found"
  exit 1
fi

IFS='|' read -r pm2_status restart_count <<<"$process_info"
if [ "$pm2_status" != "online" ]; then
  echo "FAIL: PM2 process '$PM2_PROCESS_NAME' is '$pm2_status'"
  exit 1
fi

if [ ! -f "$DB_PATH" ]; then
  echo "FAIL: database file missing at $DB_PATH"
  exit 1
fi

if ! curl -fsS --max-time 5 "$HEALTHCHECK_URL" > "$health_tmp"; then
  echo "FAIL: health endpoint check failed at $HEALTHCHECK_URL"
  exit 1
fi

if ! python3 -c 'import json, sys
path = sys.argv[1]
with open(path, "r", encoding="utf-8") as handle:
    payload = json.load(handle)
if not payload.get("ok"):
    raise SystemExit(1)' "$health_tmp"; then
  echo "FAIL: health endpoint payload invalid at $HEALTHCHECK_URL"
  exit 1
fi

echo "OK: pm2=$PM2_PROCESS_NAME status=$pm2_status restarts=$restart_count db=$DB_PATH health=$HEALTHCHECK_URL"

if [ "$restart_count" -ge "$PM2_RESTART_THRESHOLD" ]; then
  echo "WARN: restart count $restart_count crossed threshold $PM2_RESTART_THRESHOLD"
fi
