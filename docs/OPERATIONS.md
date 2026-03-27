# Operations

Use these routines for backup, restore, and basic service checks.

## Nightly backup

Cron example:

```cron
0 2 * * * cd /home/tjdot/roland-discord-bot && ./scripts/backup_db.sh >> /home/tjdot/roland-discord-bot/backups/backup.log 2>&1
```

Notes:

- Backups default to `database/solpranos.db`.
- Files are written to `backups/` with a timestamped filename.
- Retention is 14 days by default.

## Health checks

Cron example:

```cron
*/5 * * * * cd /home/tjdot/roland-discord-bot && ./scripts/healthcheck.sh >> /home/tjdot/roland-discord-bot/backups/healthcheck.log 2>&1
```

Optional environment overrides:

- `PM2_PROCESS_NAME`
- `WEB_PORT`
- `HEALTHCHECK_URL`
- `DB_PATH`

## Restore drill

1. Confirm the target backup file exists.
2. Stop the bot process if your deployment does not tolerate live SQLite replacement.
3. Run `./scripts/restore_db.sh <backup-file>`.
4. Type `RESTORE` when prompted.
5. Re-run `./scripts/healthcheck.sh`.
6. Verify the dashboard and webhook flows still work.

## Alerting suggestions

- Run `./scripts/alert_pm2_restarts.sh` from cron or your scheduler.
- Set `RESTART_ALERT_THRESHOLD` based on your acceptable churn.
- Send script output to Slack, Discord, or email through your existing alert pipeline.
- If restart counts rise, inspect PM2 logs and the last backup/restore time.
