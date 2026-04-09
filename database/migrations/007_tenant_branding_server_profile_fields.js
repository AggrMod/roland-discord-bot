module.exports = {
  version: 7,
  name: 'tenant_branding_server_profile_fields',
  up: ({ db }) => {
    const tolerantExec = (sql) => {
      try {
        db.exec(sql);
      } catch (error) {
        const message = String(error?.message || '').toLowerCase();
        const ignorable = message.includes('duplicate column name')
          || message.includes('already exists')
          || message.includes('no such table');
        if (!ignorable) throw error;
      }
    };

    tolerantExec('ALTER TABLE tenant_branding ADD COLUMN bot_server_avatar_url TEXT');
    tolerantExec('ALTER TABLE tenant_branding ADD COLUMN bot_server_banner_url TEXT');
    tolerantExec('ALTER TABLE tenant_branding ADD COLUMN bot_server_bio TEXT');
  },
};
