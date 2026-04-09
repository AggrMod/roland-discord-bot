module.exports = {
  version: 4,
  name: 'verification_rule_override_support',
  up: ({ db, logger }) => {
    const tolerantExec = (sql) => {
      try {
        db.exec(sql);
      } catch (error) {
        const message = String(error?.message || '').toLowerCase();
        const ignorable = message.includes('duplicate column name')
          || message.includes('already exists')
          || message.includes('no such table');
        if (!ignorable) {
          throw error;
        }
      }
    };

    tolerantExec('ALTER TABLE token_role_rules ADD COLUMN never_remove INTEGER DEFAULT 0');
    tolerantExec('ALTER TABLE tenant_verification_settings ADD COLUMN base_verified_role_id TEXT');
    logger.log('[DB] Migration v4 ensured verification override columns');
  }
};
