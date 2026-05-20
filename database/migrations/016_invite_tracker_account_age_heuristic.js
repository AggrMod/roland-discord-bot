function up({ db }) {
  const tolerantExec = (sql) => {
    try {
      db.exec(sql);
    } catch (error) {
      const msg = String(error?.message || '');
      const ignorable = msg.includes('duplicate column name') || msg.includes('already exists') || msg.includes('no such table');
      if (!ignorable) throw error;
    }
  };

  tolerantExec('ALTER TABLE invite_tracker_settings ADD COLUMN inviter_account_age_filter_enabled INTEGER DEFAULT 0');
  tolerantExec('ALTER TABLE invite_tracker_settings ADD COLUMN inviter_min_account_age_hours INTEGER DEFAULT 48');
}

module.exports = {
  version: 16,
  name: 'invite_tracker_account_age_heuristic',
  up,
};

