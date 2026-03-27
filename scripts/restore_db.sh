#!/usr/bin/env bash
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: $0 <backup-file>" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DB_PATH="${DB_PATH:-$REPO_ROOT/database/solpranos.db}"
BACKUP_DIR="${BACKUP_DIR:-$REPO_ROOT/backups}"
BACKUP_FILE="$1"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
PRE_RESTORE_DIR="$BACKUP_DIR/pre-restore"
PRE_RESTORE_FILE="$PRE_RESTORE_DIR/solpranos_pre_restore_${TIMESTAMP}.db"

if [ ! -f "$BACKUP_FILE" ]; then
  echo "Restore failed: backup file not found at $BACKUP_FILE" >&2
  exit 1
fi

read -r -p "This will overwrite $DB_PATH with $BACKUP_FILE. Type RESTORE to continue: " confirmation
if [ "$confirmation" != "RESTORE" ]; then
  echo "Restore cancelled."
  exit 1
fi

mkdir -p "$(dirname "$DB_PATH")" "$PRE_RESTORE_DIR"

if [ -f "$DB_PATH" ]; then
  cp "$DB_PATH" "$PRE_RESTORE_FILE"
  echo "Current database backed up to $PRE_RESTORE_FILE"
fi

cp "$BACKUP_FILE" "$DB_PATH"
echo "Restore complete: $DB_PATH"
