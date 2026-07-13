module.exports = {
  version: 27,
  name: 'guild_guard_role_identities',
  up: ({ db, logger }) => {
    try {
      db.exec('ALTER TABLE staff_identities ADD COLUMN managed_by_roles INTEGER NOT NULL DEFAULT 0');
    } catch (error) {
      if (!String(error?.message || '').includes('duplicate column name')) throw error;
    }
    logger.log('[DB] Migration v27 ensured Guild Guard role-managed staff identities');
  }
};
