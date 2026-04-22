module.exports = {
  version: 11,
  name: 'heist_template_bonus_scope',
  up: ({ db, logger }) => {
    const tolerantExec = (sql) => {
      try {
        db.exec(sql);
      } catch (error) {
        const message = String(error?.message || '').toLowerCase();
        const ignorable = message.includes('duplicate column name')
          || message.includes('already exists')
          || message.includes('no such table')
          || message.includes('no such column');
        if (!ignorable) throw error;
      }
    };

    tolerantExec('ALTER TABLE heist_trait_bonus_rules ADD COLUMN template_id INTEGER');
    tolerantExec('CREATE INDEX IF NOT EXISTS idx_heist_trait_bonus_template_scope ON heist_trait_bonus_rules(guild_id, template_id, mission_type)');

    logger.log('[DB] Migration v11 added template-scoped heist trait bonus support');
  },
};
