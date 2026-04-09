const fs = require('fs');
const path = require('path');
const db = require('../database/db');
const logger = require('../utils/logger');

function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

class DatabaseBackupService {
  constructor() {
    this.intervalHandle = null;
    this.inFlight = false;
  }

  isEnabled() {
    const raw = String(process.env.DB_BACKUP_ENABLED ?? 'true').trim().toLowerCase();
    return !(raw === 'false' || raw === '0' || raw === 'off' || raw === 'no');
  }

  getIntervalMs() {
    const minutes = Math.max(5, toPositiveInt(process.env.DB_BACKUP_INTERVAL_MINUTES, 60));
    return minutes * 60 * 1000;
  }

  getRetentionMs() {
    const hours = Math.max(1, toPositiveInt(process.env.DB_BACKUP_RETENTION_HOURS, 72));
    return hours * 60 * 60 * 1000;
  }

  getKeepMinimum() {
    return Math.max(1, toPositiveInt(process.env.DB_BACKUP_KEEP_MIN, 24));
  }

  shouldRunOnStartup() {
    const raw = String(process.env.DB_BACKUP_ON_STARTUP ?? 'true').trim().toLowerCase();
    return !(raw === 'false' || raw === '0' || raw === 'off' || raw === 'no');
  }

  getStartupDelayMs() {
    return Math.max(0, toPositiveInt(process.env.DB_BACKUP_STARTUP_DELAY_SECONDS, 30)) * 1000;
  }

  getDbPath() {
    const fromDb = typeof db?.name === 'string' ? db.name : '';
    if (fromDb) return path.resolve(fromDb);
    if (process.env.DATABASE_PATH) return path.resolve(process.env.DATABASE_PATH);
    return path.resolve(path.join(__dirname, '..', 'database', 'guildpilot.db'));
  }

  getBackupDir() {
    if (process.env.DB_BACKUP_DIR) {
      return path.resolve(process.env.DB_BACKUP_DIR);
    }
    return path.resolve(path.join(__dirname, '..', 'database', 'backups'));
  }

  ensureBackupDirExists() {
    const backupDir = this.getBackupDir();
    fs.mkdirSync(backupDir, { recursive: true });
    return backupDir;
  }

  buildBackupFileName(dbPath) {
    const baseName = path.basename(dbPath, path.extname(dbPath));
    const ext = path.extname(dbPath) || '.db';
    const now = new Date();
    const stamp = [
      now.getUTCFullYear(),
      String(now.getUTCMonth() + 1).padStart(2, '0'),
      String(now.getUTCDate()).padStart(2, '0'),
      '_',
      String(now.getUTCHours()).padStart(2, '0'),
      String(now.getUTCMinutes()).padStart(2, '0'),
      String(now.getUTCSeconds()).padStart(2, '0'),
      'Z'
    ].join('');
    return `${baseName}-${stamp}${ext}`;
  }

  pruneOldBackups(dbPath, backupDir) {
    const cutoff = Date.now() - this.getRetentionMs();
    const baseName = path.basename(dbPath, path.extname(dbPath));
    const ext = path.extname(dbPath) || '.db';
    const prefix = `${baseName}-`;

    let entries = [];
    try {
      entries = fs.readdirSync(backupDir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .filter((entry) => entry.name.startsWith(prefix) && entry.name.endsWith(ext))
        .map((entry) => {
          const fullPath = path.join(backupDir, entry.name);
          const stat = fs.statSync(fullPath);
          return {
            fullPath,
            mtimeMs: stat.mtimeMs,
            name: entry.name
          };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
    } catch (error) {
      logger.warn('[db-backup] Failed to list backups for pruning:', error?.message || error);
      return { deleted: 0 };
    }

    const keepMinimum = this.getKeepMinimum();
    const toDelete = entries
      .slice(keepMinimum)
      .filter((entry) => entry.mtimeMs < cutoff);

    let deleted = 0;
    for (const entry of toDelete) {
      try {
        fs.unlinkSync(entry.fullPath);
        deleted += 1;
      } catch (error) {
        logger.warn(`[db-backup] Failed deleting old backup ${entry.name}:`, error?.message || error);
      }
    }

    return { deleted };
  }

  async runBackup(reason = 'manual') {
    if (!this.isEnabled()) {
      return { success: false, skipped: true, message: 'Backups disabled' };
    }
    if (this.inFlight) {
      return { success: false, skipped: true, message: 'Backup already running' };
    }

    this.inFlight = true;
    const dbPath = this.getDbPath();
    const backupDir = this.ensureBackupDirExists();
    const backupName = this.buildBackupFileName(dbPath);
    const destination = path.join(backupDir, backupName);

    try {
      if (!fs.existsSync(dbPath)) {
        throw new Error(`Database file not found at ${dbPath}`);
      }

      if (typeof db.backup === 'function') {
        await db.backup(destination);
      } else {
        fs.copyFileSync(dbPath, destination);
      }

      const prune = this.pruneOldBackups(dbPath, backupDir);
      logger.log(`[db-backup] Created backup (${reason}): ${backupName}${prune.deleted ? ` | pruned=${prune.deleted}` : ''}`);
      return { success: true, path: destination, pruned: prune.deleted };
    } catch (error) {
      logger.error('[db-backup] Backup failed:', error);
      return { success: false, message: error?.message || 'Backup failed' };
    } finally {
      this.inFlight = false;
    }
  }

  start() {
    if (!this.isEnabled()) {
      logger.log('[db-backup] Disabled via DB_BACKUP_ENABLED');
      return;
    }
    if (this.intervalHandle) {
      return;
    }

    this.ensureBackupDirExists();
    const intervalMs = this.getIntervalMs();
    this.intervalHandle = setInterval(() => {
      this.runBackup('scheduled').catch((error) => {
        logger.error('[db-backup] Scheduled backup failed:', error);
      });
    }, intervalMs);

    if (this.shouldRunOnStartup()) {
      setTimeout(() => {
        this.runBackup('startup').catch((error) => {
          logger.error('[db-backup] Startup backup failed:', error);
        });
      }, this.getStartupDelayMs());
    }

    logger.log(`[db-backup] Scheduler started | every ${Math.round(intervalMs / 60000)} min | dir=${this.getBackupDir()}`);
  }

  stop() {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
      logger.log('[db-backup] Scheduler stopped');
    }
  }
}

module.exports = new DatabaseBackupService();
