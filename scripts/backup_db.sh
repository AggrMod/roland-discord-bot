#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DB_PATH="${DB_PATH:-$REPO_ROOT/database/solpranos.db}"
BACKUP_DIR="${BACKUP_DIR:-$REPO_ROOT/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
BACKUP_FILE="$BACKUP_DIR/solpranos_${TIMESTAMP}.db"

mkdir -p "$BACKUP_DIR"

if [ ! -f "$DB_PATH" ]; then
  echo "Backup failed: database file not found at $DB_PATH" >&2
  exit 1
fi

python3 - "$DB_PATH" "$BACKUP_FILE" <<'PY'
import os
import sqlite3
import sys

src, dst = sys.argv[1:3]
os.makedirs(os.path.dirname(dst), exist_ok=True)

with sqlite3.connect(src) as source, sqlite3.connect(dst) as target:
    source.backup(target)
PY

find "$BACKUP_DIR" -maxdepth 1 -type f -name 'solpranos_*.db' -mtime +"$RETENTION_DAYS" -delete

echo "Backup created: $BACKUP_FILE"
