#!/usr/bin/env bash
set -euo pipefail

PM2_PROCESS_NAME="${PM2_PROCESS_NAME:-roland-bot}"
RESTART_ALERT_THRESHOLD="${RESTART_ALERT_THRESHOLD:-10}"

if ! command -v pm2 >/dev/null 2>&1; then
  echo "WARN: pm2 is not installed or not on PATH"
  exit 1
fi

pm2_json="$(pm2 jlist 2>/dev/null || true)"
if [ -z "$pm2_json" ]; then
  echo "WARN: unable to read pm2 process list"
  exit 1
fi

pm2_tmp="$(mktemp)"
trap 'rm -f "$pm2_tmp"' EXIT
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
  echo "WARN: PM2 process '$PM2_PROCESS_NAME' not found"
  exit 1
fi

IFS='|' read -r pm2_status restart_count <<<"$process_info"
if [ "$restart_count" -ge "$RESTART_ALERT_THRESHOLD" ]; then
  echo "WARN: PM2 process '$PM2_PROCESS_NAME' restart count is $restart_count (threshold $RESTART_ALERT_THRESHOLD, status=$pm2_status)"
  exit 2
fi

echo "OK: PM2 process '$PM2_PROCESS_NAME' restart count is $restart_count"
