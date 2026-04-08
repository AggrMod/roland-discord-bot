const Database = require('better-sqlite3');
const path = require('path');
const logger = require('../utils/logger');

const dbPath = process.env.DATABASE_PATH || path.join(__dirname, 'solpranos.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function initDatabase() {
  logger.log('Initializing database...');

  // Migration: add missing columns
  const ignoreDuplicateMigration = (fn) => {
    try { fn(); } catch(e) {
      if (!e.message.includes('duplicate column name') && !e.message.includes('already exists') && !e.message.includes('no such table')) {
        throw e;
      }
    }
  };

  ignoreDuplicateMigration(() => db.exec('ALTER TABLE proposals ADD COLUMN voting_message_id TEXT'));
  ignoreDuplicateMigration(() => db.exec('ALTER TABLE proposals ADD COLUMN message_id TEXT'));
  ignoreDuplicateMigration(() => db.exec('ALTER TABLE proposals ADD COLUMN channel_id TEXT'));
  ignoreDuplicateMigration(() => db.exec('ALTER TABLE wallets ADD COLUMN is_favorite BOOLEAN DEFAULT 0'));
  ignoreDuplicateMigration(() => db.exec('ALTER TABLE users ADD COLUMN wallet_alert_identity_opt_out INTEGER DEFAULT 0'));
  ignoreDuplicateMigration(() => db.exec("ALTER TABLE verification_panels ADD COLUMN color TEXT DEFAULT '#FFD700'"));
  ignoreDuplicateMigration(() => db.exec('ALTER TABLE verification_panels ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP'));
  ignoreDuplicateMigration(() => db.exec('CREATE TABLE user_verify_amounts (id INTEGER PRIMARY KEY AUTOINCREMENT, discord_id TEXT UNIQUE NOT NULL, username TEXT, assigned_amount REAL NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)'));

  // Governance overhaul migrations
  ignoreDuplicateMigration(() => db.exec("ALTER TABLE proposals ADD COLUMN category TEXT DEFAULT 'Other'"));
  ignoreDuplicateMigration(() => db.exec('ALTER TABLE proposals ADD COLUMN cost_indication TEXT'));
  ignoreDuplicateMigration(() => db.exec('ALTER TABLE proposals ADD COLUMN veto_reason TEXT'));
  ignoreDuplicateMigration(() => db.exec('ALTER TABLE proposals ADD COLUMN veto_votes TEXT'));
  ignoreDuplicateMigration(() => db.exec('ALTER TABLE proposals ADD COLUMN vp_snapshot TEXT'));
  ignoreDuplicateMigration(() => db.exec('ALTER TABLE proposals ADD COLUMN quorum_required INTEGER'));
  ignoreDuplicateMigration(() => db.exec('ALTER TABLE proposals ADD COLUMN on_hold_reason TEXT'));
  ignoreDuplicateMigration(() => db.exec('ALTER TABLE proposals ADD COLUMN promoted_by TEXT'));
  ignoreDuplicateMigration(() => db.exec('ALTER TABLE proposals ADD COLUMN paused INTEGER DEFAULT 0'));
  ignoreDuplicateMigration(() => db.exec('ALTER TABLE nft_tracked_collections ADD COLUMN me_symbol TEXT DEFAULT ""'));

  // VP decoupling: role-to-voting-power mapping table
  db.exec(`
    CREATE TABLE IF NOT EXISTS role_vp_mappings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role_id TEXT NOT NULL UNIQUE,
      role_name TEXT,
      voting_power INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS superadmins (
      discord_id TEXT PRIMARY KEY,
      added_by TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      discord_id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      total_nfts INTEGER DEFAULT 0,
      total_tokens REAL DEFAULT 0,
      tier TEXT,
      voting_power INTEGER DEFAULT 0,
      wallet_alert_identity_opt_out INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS wallets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      discord_id TEXT NOT NULL,
      wallet_address TEXT NOT NULL UNIQUE,
      verified BOOLEAN DEFAULT 1,
      primary_wallet BOOLEAN DEFAULT 0,
      is_favorite BOOLEAN DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (discord_id) REFERENCES users(discord_id)
    );

    CREATE TABLE IF NOT EXISTS micro_verify_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      discord_id TEXT NOT NULL,
      username TEXT NOT NULL,
      guild_id TEXT DEFAULT '',
      expected_amount REAL NOT NULL,
      destination_wallet TEXT NOT NULL,
      sender_wallet TEXT,
      tx_signature TEXT,
      status TEXT DEFAULT 'pending',
      expires_at DATETIME NOT NULL,
      verified_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (discord_id) REFERENCES users(discord_id)
    );

    CREATE TABLE IF NOT EXISTS micro_verify_tx_checks (
      signature TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      sol_amount REAL,
      matched_request_id INTEGER,
      sender_wallet TEXT,
      checked_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS proposals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      proposal_id TEXT UNIQUE NOT NULL,
      creator_id TEXT NOT NULL,
      creator_wallet TEXT,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT DEFAULT 'draft',
      total_vp INTEGER DEFAULT 0,
      yes_vp INTEGER DEFAULT 0,
      no_vp INTEGER DEFAULT 0,
      abstain_vp INTEGER DEFAULT 0,
      quorum_threshold INTEGER DEFAULT 25,
      start_time DATETIME,
      end_time DATETIME,
      message_id TEXT,
      channel_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (creator_id) REFERENCES users(discord_id)
    );

    CREATE TABLE IF NOT EXISTS proposal_supporters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      proposal_id TEXT NOT NULL,
      supporter_id TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (proposal_id) REFERENCES proposals(proposal_id),
      FOREIGN KEY (supporter_id) REFERENCES users(discord_id),
      UNIQUE(proposal_id, supporter_id)
    );

    CREATE TABLE IF NOT EXISTS proposal_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      proposal_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      author_name TEXT,
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (proposal_id) REFERENCES proposals(proposal_id)
    );

    CREATE TABLE IF NOT EXISTS proposal_veto_votes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      proposal_id TEXT NOT NULL,
      voter_id TEXT NOT NULL,
      reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (proposal_id) REFERENCES proposals(proposal_id),
      UNIQUE(proposal_id, voter_id)
    );

    CREATE TABLE IF NOT EXISTS proposal_support (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      proposal_id TEXT NOT NULL,
      supporter_id TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (proposal_id) REFERENCES proposals(proposal_id),
      UNIQUE(proposal_id, supporter_id)
    );

    CREATE TABLE IF NOT EXISTS votes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      proposal_id TEXT NOT NULL,
      voter_id TEXT NOT NULL,
      vote_choice TEXT NOT NULL,
      voting_power INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (proposal_id) REFERENCES proposals(proposal_id),
      FOREIGN KEY (voter_id) REFERENCES users(discord_id),
      UNIQUE(proposal_id, voter_id)
    );

    CREATE TABLE IF NOT EXISTS missions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mission_id TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      required_roles TEXT,
      min_tier TEXT,
      total_slots INTEGER NOT NULL,
      filled_slots INTEGER DEFAULT 0,
      reward_points INTEGER DEFAULT 0,
      status TEXT DEFAULT 'recruiting',
      start_time DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS mission_participants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mission_id TEXT NOT NULL,
      participant_id TEXT NOT NULL,
      wallet_address TEXT NOT NULL,
      assigned_nft_mint TEXT NOT NULL,
      assigned_nft_name TEXT,
      assigned_role TEXT NOT NULL,
      points_awarded INTEGER DEFAULT 0,
      joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (mission_id) REFERENCES missions(mission_id),
      FOREIGN KEY (participant_id) REFERENCES users(discord_id),
      UNIQUE(mission_id, participant_id)
    );

    CREATE INDEX IF NOT EXISTS idx_wallets_discord_id ON wallets(discord_id);
    CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status);
    CREATE INDEX IF NOT EXISTS idx_votes_proposal ON votes(proposal_id);
    CREATE INDEX IF NOT EXISTS idx_missions_status ON missions(status);
    CREATE INDEX IF NOT EXISTS idx_mission_participants_mission ON mission_participants(mission_id);
    CREATE TABLE IF NOT EXISTS nft_activity_watch (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      collection_key TEXT UNIQUE NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS nft_activity_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      collection_key TEXT,
      token_mint TEXT,
      token_name TEXT,
      from_wallet TEXT,
      to_wallet TEXT,
      price_sol REAL,
      tx_signature TEXT,
      source TEXT DEFAULT 'unknown',
      event_time DATETIME,
      raw_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS nft_activity_alert_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled BOOLEAN DEFAULT 0,
      channel_id TEXT,
      event_types TEXT DEFAULT 'mint,sell,list,delist,transfer',
      min_sol REAL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS nft_tracked_collections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL DEFAULT '',
      collection_address TEXT NOT NULL,
      collection_name TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      track_mint INTEGER DEFAULT 1,
      track_sale INTEGER DEFAULT 1,
      track_list INTEGER DEFAULT 1,
      track_delist INTEGER DEFAULT 1,
      track_transfer INTEGER DEFAULT 0,
      enabled INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(guild_id, collection_address)
    );

    CREATE INDEX IF NOT EXISTS idx_micro_verify_discord_id ON micro_verify_requests(discord_id);
    CREATE INDEX IF NOT EXISTS idx_micro_verify_status ON micro_verify_requests(status);
    CREATE INDEX IF NOT EXISTS idx_micro_verify_amount ON micro_verify_requests(expected_amount);
    CREATE INDEX IF NOT EXISTS idx_micro_verify_tx_checks_checked_at ON micro_verify_tx_checks(checked_at);
    CREATE INDEX IF NOT EXISTS idx_nft_activity_events_time ON nft_activity_events(event_time);
    CREATE INDEX IF NOT EXISTS idx_nft_activity_events_collection ON nft_activity_events(collection_key);
    CREATE INDEX IF NOT EXISTS idx_nft_activity_events_type ON nft_activity_events(event_type);
    CREATE INDEX IF NOT EXISTS idx_proposal_comments_proposal ON proposal_comments(proposal_id);
    CREATE INDEX IF NOT EXISTS idx_proposal_veto_votes_proposal ON proposal_veto_votes(proposal_id);
    CREATE INDEX IF NOT EXISTS idx_proposal_support_proposal ON proposal_support(proposal_id);

    CREATE TABLE IF NOT EXISTS ticket_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL,
      emoji TEXT DEFAULT '🎫',
      description TEXT,
      parent_channel_id TEXT,
      closed_parent_channel_id TEXT,
      handler_role_ids TEXT DEFAULT '[]',
      allowed_role_ids TEXT DEFAULT '[]',
      ping_role_ids TEXT DEFAULT '[]',
      template_fields TEXT DEFAULT '[]',
      enabled INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_number INTEGER,
      guild_id TEXT DEFAULT '',
      category_id INTEGER,
      category_name TEXT,
      channel_id TEXT UNIQUE,
      opener_id TEXT NOT NULL,
      opener_name TEXT,
      claimed_by TEXT,
      handler_role_ids TEXT DEFAULT '[]',
      status TEXT DEFAULT 'open',
      template_responses TEXT DEFAULT '{}',
      transcript TEXT,
      last_activity_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      inactive_warning_sent_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      closed_at DATETIME,
      FOREIGN KEY (category_id) REFERENCES ticket_categories(id),
      UNIQUE(guild_id, ticket_number)
    );

    CREATE TABLE IF NOT EXISTS ticket_panels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL DEFAULT '',
      channel_id TEXT NOT NULL UNIQUE,
      message_id TEXT,
      title TEXT DEFAULT 'Support',
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS verification_panels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL UNIQUE,
      channel_id TEXT NOT NULL,
      message_id TEXT,
      title TEXT DEFAULT '🔗 Verify your wallet!',
      description TEXT DEFAULT 'To get access to community roles, verify your wallet by clicking the button below.',
      color TEXT DEFAULT '#FFD700',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS ticket_sequences (
      name TEXT PRIMARY KEY,
      value INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS ticket_guild_settings (
      guild_id TEXT PRIMARY KEY,
      channel_name_template TEXT DEFAULT '{category}-{user}-{date}',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
    CREATE INDEX IF NOT EXISTS idx_tickets_opener ON tickets(opener_id);
    CREATE INDEX IF NOT EXISTS idx_tickets_category ON tickets(category_id);
    CREATE INDEX IF NOT EXISTS idx_tickets_channel ON tickets(channel_id);
    CREATE INDEX IF NOT EXISTS idx_ticket_guild_settings_guild ON ticket_guild_settings(guild_id);
    CREATE INDEX IF NOT EXISTS idx_ticket_panels_channel ON ticket_panels(channel_id);
    CREATE INDEX IF NOT EXISTS idx_verification_panels_guild ON verification_panels(guild_id);

    CREATE TABLE IF NOT EXISTS tenants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL UNIQUE,
      guild_name TEXT,
      plan_key TEXT DEFAULT 'starter',
      status TEXT DEFAULT 'active',
      read_only_managed INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS tenant_modules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      module_key TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
      UNIQUE(tenant_id, module_key)
    );

    CREATE TABLE IF NOT EXISTS tenant_verification_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL UNIQUE,
      og_role_id TEXT,
      og_role_limit INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS tenant_branding (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL UNIQUE,
      bot_display_name TEXT,
      brand_emoji TEXT,
      brand_color TEXT,
      display_name TEXT,
      primary_color TEXT,
      secondary_color TEXT,
      logo_url TEXT,
      icon_url TEXT,
      support_url TEXT,
      footer_text TEXT,
      ticketing_color TEXT,
      selfserve_color TEXT,
      nfttracker_color TEXT,
      ticket_panel_title TEXT,
      ticket_panel_description TEXT,
      selfserve_panel_title TEXT,
      selfserve_panel_description TEXT,
      nfttracker_panel_title TEXT,
      nfttracker_panel_description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS tenant_audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      actor_id TEXT,
      action TEXT NOT NULL,
      before_json TEXT,
      after_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS tenant_limits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL UNIQUE,
      max_commands INTEGER,
      max_enabled_modules INTEGER,
      max_branding_profiles INTEGER,
      max_read_only_overrides INTEGER,
      mock_data_enabled INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_tenants_guild_id ON tenants(guild_id);
    CREATE INDEX IF NOT EXISTS idx_tenant_modules_tenant ON tenant_modules(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_tenant_modules_key ON tenant_modules(module_key);
    CREATE INDEX IF NOT EXISTS idx_tenant_audit_logs_guild_created ON tenant_audit_logs(guild_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS billing_entitlement_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT,
      customer_id TEXT,
      event_type TEXT NOT NULL,
      payload_hash TEXT NOT NULL UNIQUE,
      payload_json TEXT NOT NULL,
      result TEXT NOT NULL,
      processed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_billing_entitlement_events_guild_created
      ON billing_entitlement_events(guild_id, processed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_billing_entitlement_events_customer_created
      ON billing_entitlement_events(customer_id, processed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_billing_entitlement_events_event_type
      ON billing_entitlement_events(event_type);
  `);

  // [DB-003] Additional performance indexes
  const indexes = [
    'CREATE INDEX IF NOT EXISTS idx_votes_voter_id ON votes(voter_id)',
    'CREATE INDEX IF NOT EXISTS idx_micro_verify_sender ON micro_verify_requests(sender_wallet)',
    'CREATE INDEX IF NOT EXISTS idx_micro_verify_dest ON micro_verify_requests(destination_wallet)',
    'CREATE INDEX IF NOT EXISTS idx_nft_activity_wallet ON nft_activity_log(wallet_address)',
    'CREATE INDEX IF NOT EXISTS idx_tickets_guild ON tickets(guild_id)',
    'CREATE INDEX IF NOT EXISTS idx_tickets_status_v2 ON tickets(status)',
    'CREATE INDEX IF NOT EXISTS idx_proposals_guild ON proposals(guild_id)',
    'CREATE INDEX IF NOT EXISTS idx_wallets_discord ON user_wallets(discord_id)',
  ];
  indexes.forEach(sql => { try { db.exec(sql); } catch(e) { /* index may already exist or table missing */ } });

  // [DB-004] Auto-update updated_at timestamps
  const triggers = [
    `CREATE TRIGGER IF NOT EXISTS update_proposals_timestamp AFTER UPDATE ON proposals BEGIN UPDATE proposals SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id; END`,
    `CREATE TRIGGER IF NOT EXISTS update_settings_timestamp AFTER UPDATE ON guild_settings BEGIN UPDATE guild_settings SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id; END`,
    `CREATE TRIGGER IF NOT EXISTS update_votes_timestamp AFTER UPDATE ON votes BEGIN UPDATE votes SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id; END`,
    `CREATE TRIGGER IF NOT EXISTS update_micro_verify_timestamp AFTER UPDATE ON micro_verify_requests BEGIN UPDATE micro_verify_requests SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id; END`,
    'ALTER TABLE micro_verify_requests ADD COLUMN guild_id TEXT DEFAULT ""',
    'ALTER TABLE tickets ADD COLUMN guild_id TEXT DEFAULT ""',
    'ALTER TABLE tenant_verification_settings ADD COLUMN og_role_id TEXT',
    'ALTER TABLE tenant_verification_settings ADD COLUMN og_role_limit INTEGER DEFAULT 0',
    'ALTER TABLE tenant_branding ADD COLUMN footer_text TEXT',
    'ALTER TABLE tenant_branding ADD COLUMN ticketing_color TEXT',
    'ALTER TABLE tenant_branding ADD COLUMN selfserve_color TEXT',
    'ALTER TABLE tenant_branding ADD COLUMN nfttracker_color TEXT',
    'ALTER TABLE tenant_branding ADD COLUMN ticket_panel_title TEXT',
    'ALTER TABLE tenant_branding ADD COLUMN ticket_panel_description TEXT',
    'ALTER TABLE tenant_branding ADD COLUMN selfserve_panel_title TEXT',
    'ALTER TABLE tenant_branding ADD COLUMN selfserve_panel_description TEXT',
    'ALTER TABLE tenant_branding ADD COLUMN nfttracker_panel_title TEXT',
    'ALTER TABLE tenant_branding ADD COLUMN nfttracker_panel_description TEXT',
    `CREATE TRIGGER IF NOT EXISTS update_tenants_timestamp AFTER UPDATE ON tenants BEGIN UPDATE tenants SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id; END`,
    `CREATE TRIGGER IF NOT EXISTS update_tenant_modules_timestamp AFTER UPDATE ON tenant_modules BEGIN UPDATE tenant_modules SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id; END`,
    `CREATE TRIGGER IF NOT EXISTS update_tenant_branding_timestamp AFTER UPDATE ON tenant_branding BEGIN UPDATE tenant_branding SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id; END`,
    `CREATE TRIGGER IF NOT EXISTS update_tenant_limits_timestamp AFTER UPDATE ON tenant_limits BEGIN UPDATE tenant_limits SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id; END`,
    `CREATE TRIGGER IF NOT EXISTS update_nft_alert_config_timestamp AFTER UPDATE ON nft_activity_alert_config BEGIN UPDATE nft_activity_alert_config SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id; END`,
    `CREATE TRIGGER IF NOT EXISTS update_tenant_role_configs_timestamp AFTER UPDATE ON tenant_role_configs BEGIN UPDATE tenant_role_configs SET updated_at = CURRENT_TIMESTAMP WHERE rowid = NEW.rowid; END`,
  ];
  triggers.forEach(sql => { try { db.exec(sql); } catch(e) {} });

  // Backward-compatible migrations for existing deployments
  try { db.exec("ALTER TABLE tenants ADD COLUMN plan_key TEXT DEFAULT 'starter'"); } catch (e) {}
  try { db.exec("ALTER TABLE tenants ADD COLUMN status TEXT DEFAULT 'active'"); } catch (e) {}
  try { db.exec("ALTER TABLE tenant_branding ADD COLUMN bot_display_name TEXT"); } catch (e) {}
  try { db.exec("ALTER TABLE tenant_branding ADD COLUMN brand_emoji TEXT"); } catch (e) {}
  try { db.exec("ALTER TABLE tenant_branding ADD COLUMN brand_color TEXT"); } catch (e) {}
  try { db.exec("ALTER TABLE ticket_categories ADD COLUMN closed_parent_channel_id TEXT"); } catch (e) {}
  try { db.exec("ALTER TABLE ticket_categories ADD COLUMN handler_role_ids TEXT DEFAULT '[]'"); } catch (e) {}
  try { db.exec("ALTER TABLE ticket_categories ADD COLUMN ping_role_ids TEXT DEFAULT '[]'"); } catch (e) {}
  try { db.exec("ALTER TABLE ticket_categories ADD COLUMN guild_id TEXT NOT NULL DEFAULT ''"); } catch (e) {}
  try { db.exec("ALTER TABLE ticket_panels ADD COLUMN guild_id TEXT NOT NULL DEFAULT ''"); } catch (e) {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_ticket_categories_guild ON ticket_categories(guild_id)"); } catch (e) {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_ticket_panels_guild ON ticket_panels(guild_id)"); } catch (e) {}
  try { db.exec("ALTER TABLE tickets ADD COLUMN handler_role_ids TEXT DEFAULT '[]'"); } catch (e) {}
  try { db.exec("ALTER TABLE tickets ADD COLUMN last_activity_at DATETIME"); } catch (e) {}
  try { db.exec("ALTER TABLE tickets ADD COLUMN inactive_warning_sent_at DATETIME"); } catch (e) {}
  try {
    const idxList = db.prepare("PRAGMA index_list('tickets')").all();
    let hasCompositeGuildTicketUnique = false;
    let hasLegacyTicketNumberUnique = false;

    for (const idx of idxList) {
      if (!idx?.unique) continue;
      const cols = db.prepare(`PRAGMA index_info(${JSON.stringify(idx.name)})`).all().map(c => c.name);
      if (cols.length === 2 && cols.includes('guild_id') && cols.includes('ticket_number')) {
        hasCompositeGuildTicketUnique = true;
      }
      if (cols.length === 1 && cols[0] === 'ticket_number') {
        hasLegacyTicketNumberUnique = true;
      }
    }

    if (hasLegacyTicketNumberUnique && !hasCompositeGuildTicketUnique) {
      db.exec(`
        ALTER TABLE tickets RENAME TO tickets_legacy;

        CREATE TABLE tickets (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ticket_number INTEGER,
          guild_id TEXT DEFAULT '',
          category_id INTEGER,
          category_name TEXT,
          channel_id TEXT UNIQUE,
          opener_id TEXT NOT NULL,
          opener_name TEXT,
          claimed_by TEXT,
          handler_role_ids TEXT DEFAULT '[]',
          status TEXT DEFAULT 'open',
          template_responses TEXT DEFAULT '{}',
          transcript TEXT,
          last_activity_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          inactive_warning_sent_at DATETIME,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          closed_at DATETIME,
          FOREIGN KEY (category_id) REFERENCES ticket_categories(id),
          UNIQUE(guild_id, ticket_number)
        );

        INSERT INTO tickets (
          id, ticket_number, guild_id, category_id, category_name, channel_id,
          opener_id, opener_name, claimed_by, handler_role_ids, status,
          template_responses, transcript, last_activity_at, inactive_warning_sent_at,
          created_at, closed_at
        )
        SELECT
          id, ticket_number, COALESCE(guild_id, ''), category_id, category_name, channel_id,
          opener_id, opener_name, claimed_by, COALESCE(handler_role_ids, '[]'), status,
          COALESCE(template_responses, '{}'), transcript,
          COALESCE(last_activity_at, created_at, CURRENT_TIMESTAMP),
          inactive_warning_sent_at,
          COALESCE(created_at, CURRENT_TIMESTAMP),
          closed_at
        FROM tickets_legacy;

        DROP TABLE tickets_legacy;
      `);

      db.exec("CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_tickets_opener ON tickets(opener_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_tickets_category ON tickets(category_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_tickets_channel ON tickets(channel_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_tickets_guild ON tickets(guild_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_tickets_last_activity ON tickets(last_activity_at)");
    }
  } catch (e) {}
  try { db.exec(`
    CREATE TABLE IF NOT EXISTS ticket_guild_settings (
      guild_id TEXT PRIMARY KEY,
      channel_name_template TEXT DEFAULT '{category}-{user}-{date}',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `); } catch (e) {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_ticket_guild_settings_guild ON ticket_guild_settings(guild_id)"); } catch (e) {}
  try { db.exec("ALTER TABLE ticket_guild_settings ADD COLUMN channel_name_template TEXT DEFAULT '{category}-{user}-{date}'"); } catch (e) {}
  try {
    const splitSharedTicketCategories = db.transaction(() => {
      const legacyCategories = db.prepare(`
        SELECT *
        FROM ticket_categories
        WHERE COALESCE(guild_id, '') = ''
      `).all();
      if (legacyCategories.length === 0) return;

      const guildRowsByCategoryStmt = db.prepare(`
        SELECT DISTINCT guild_id
        FROM tickets
        WHERE category_id = ?
          AND COALESCE(guild_id, '') <> ''
      `);
      const assignCategoryGuildStmt = db.prepare(`
        UPDATE ticket_categories
        SET guild_id = ?
        WHERE id = ?
      `);
      const cloneCategoryStmt = db.prepare(`
        INSERT INTO ticket_categories (
          guild_id, name, emoji, description, parent_channel_id, closed_parent_channel_id,
          handler_role_ids, allowed_role_ids, ping_role_ids, template_fields, enabled, sort_order, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const retargetTicketsStmt = db.prepare(`
        UPDATE tickets
        SET category_id = ?, category_name = ?
        WHERE category_id = ?
          AND guild_id = ?
      `);

      for (const category of legacyCategories) {
        const guildIds = guildRowsByCategoryStmt
          .all(category.id)
          .map(row => String(row.guild_id || '').trim())
          .filter(Boolean);
        const uniqueGuildIds = [...new Set(guildIds)];
        if (uniqueGuildIds.length === 0) continue;

        const [primaryGuildId, ...secondaryGuildIds] = uniqueGuildIds;
        assignCategoryGuildStmt.run(primaryGuildId, category.id);

        for (const guildId of secondaryGuildIds) {
          const cloneResult = cloneCategoryStmt.run(
            guildId,
            category.name,
            category.emoji || '🎫',
            category.description || '',
            category.parent_channel_id || null,
            category.closed_parent_channel_id || null,
            category.handler_role_ids || '[]',
            category.allowed_role_ids || '[]',
            category.ping_role_ids || '[]',
            category.template_fields || '[]',
            category.enabled === 0 ? 0 : 1,
            Number.isFinite(category.sort_order) ? category.sort_order : 0,
            category.created_at || null
          );
          retargetTicketsStmt.run(Number(cloneResult.lastInsertRowid), category.name || '', category.id, guildId);
        }
      }
    });

    splitSharedTicketCategories();
  } catch (e) {}
  try { db.exec(`
    UPDATE ticket_categories
    SET handler_role_ids = COALESCE(NULLIF(allowed_role_ids, ''), '[]')
    WHERE handler_role_ids IS NULL OR handler_role_ids = '' OR handler_role_ids = '[]'
  `); } catch (e) {}
  try { db.exec(`
    UPDATE tickets
    SET handler_role_ids = COALESCE(
      NULLIF(handler_role_ids, ''),
      (SELECT COALESCE(tc.handler_role_ids, tc.allowed_role_ids, '[]') FROM ticket_categories tc WHERE tc.id = tickets.category_id),
      '[]'
    )
    WHERE handler_role_ids IS NULL OR handler_role_ids = '' OR handler_role_ids = '[]'
  `); } catch (e) {}
  try { db.exec(`
    UPDATE tickets
    SET last_activity_at = COALESCE(last_activity_at, created_at, CURRENT_TIMESTAMP)
    WHERE last_activity_at IS NULL OR last_activity_at = ''
  `); } catch (e) {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_tickets_last_activity ON tickets(last_activity_at)"); } catch (e) {}
  try { db.exec("ALTER TABLE tenant_limits ADD COLUMN mock_data_enabled INTEGER DEFAULT 0"); } catch (e) {}
  try { db.exec("ALTER TABLE tenant_modules ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP"); } catch (e) {}
  try { db.exec("ALTER TABLE nft_tracked_collections ADD COLUMN guild_id TEXT NOT NULL DEFAULT ''"); } catch (e) {}
  try { db.exec("ALTER TABLE nft_tracked_collections ADD COLUMN me_symbol TEXT DEFAULT ''"); } catch (e) {}
  try { db.exec('ALTER TABLE nft_tracked_collections ADD COLUMN track_bid INTEGER DEFAULT 0'); } catch (e) {}

  // Ensure nft_tracked_collections supports per-tenant duplicate collection addresses.
  // Legacy deployments may still have a global UNIQUE(collection_address) constraint.
  try {
    const idxList = db.prepare("PRAGMA index_list('nft_tracked_collections')").all();
    let hasCompositeUnique = false;
    let hasLegacySingleAddressUnique = false;

    for (const idx of idxList) {
      if (!idx?.unique) continue;
      const cols = db.prepare(`PRAGMA index_info(${JSON.stringify(idx.name)})`).all().map(c => c.name);
      if (cols.length === 2 && cols.includes('guild_id') && cols.includes('collection_address')) {
        hasCompositeUnique = true;
      }
      if (cols.length === 1 && cols[0] === 'collection_address') {
        hasLegacySingleAddressUnique = true;
      }
    }

    if (hasLegacySingleAddressUnique && !hasCompositeUnique) {
      db.exec(`
        ALTER TABLE nft_tracked_collections RENAME TO nft_tracked_collections_legacy;

        CREATE TABLE nft_tracked_collections (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          guild_id TEXT NOT NULL DEFAULT '',
          collection_address TEXT NOT NULL,
          collection_name TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          track_mint INTEGER DEFAULT 1,
          track_sale INTEGER DEFAULT 1,
          track_list INTEGER DEFAULT 1,
          track_delist INTEGER DEFAULT 1,
          track_transfer INTEGER DEFAULT 0,
          me_symbol TEXT DEFAULT '',
          enabled INTEGER DEFAULT 1,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(guild_id, collection_address)
        );

        INSERT INTO nft_tracked_collections (
          id, guild_id, collection_address, collection_name, channel_id,
          track_mint, track_sale, track_list, track_delist, track_transfer,
          me_symbol, enabled, created_at
        )
        SELECT
          id,
          COALESCE(guild_id, ''),
          collection_address,
          collection_name,
          channel_id,
          COALESCE(track_mint, 1),
          COALESCE(track_sale, 1),
          COALESCE(track_list, 1),
          COALESCE(track_delist, 1),
          COALESCE(track_transfer, 0),
          COALESCE(me_symbol, ''),
          COALESCE(enabled, 1),
          COALESCE(created_at, CURRENT_TIMESTAMP)
        FROM nft_tracked_collections_legacy;

        DROP TABLE nft_tracked_collections_legacy;
      `);
    }
  } catch (e) {}

  // Add UNIQUE index to tenant_modules for ON CONFLICT upsert — deduplicate first, keep latest
  try {
    db.exec(`
      DELETE FROM tenant_modules WHERE id NOT IN (
        SELECT MAX(id) FROM tenant_modules GROUP BY tenant_id, module_key
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_modules_unique ON tenant_modules(tenant_id, module_key);
    `);
  } catch (e) {}
  try { db.exec("ALTER TABLE tenant_modules ADD COLUMN created_at DATETIME DEFAULT CURRENT_TIMESTAMP"); } catch (e) {}
  try { db.exec("ALTER TABLE tenant_branding ADD COLUMN support_url TEXT"); } catch (e) {}
  try { db.exec("ALTER TABLE tenant_branding ADD COLUMN secondary_color TEXT"); } catch (e) {}
  try { db.exec("ALTER TABLE tenant_branding ADD COLUMN icon_url TEXT"); } catch (e) {}
  try { db.exec("ALTER TABLE tenant_branding ADD COLUMN logo_url TEXT"); } catch (e) {}
  try { db.exec("ALTER TABLE tenant_branding ADD COLUMN primary_color TEXT"); } catch (e) {}
  try { db.exec("ALTER TABLE tenant_branding ADD COLUMN display_name TEXT"); } catch (e) {}

  try {
    db.exec(`
      UPDATE tenants
      SET plan_key = COALESCE(NULLIF(plan_key, ''), 'starter'),
          status = COALESCE(NULLIF(status, ''), 'active')
    `);
  } catch (e) {}

  // DB-005: Consolidate duplicate proposal support tables
  // proposal_supporters is canonical; proposal_support is deprecated
  try {
    db.exec(`INSERT OR IGNORE INTO proposal_supporters (proposal_id, supporter_id, created_at)
      SELECT proposal_id, supporter_id, created_at FROM proposal_support`);
  } catch(e) { /* proposal_support may not have data */ }

  // Battle era assignments (superadmin-managed)
  db.exec(`
    CREATE TABLE IF NOT EXISTS battle_era_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      era_key TEXT NOT NULL,
      assigned_by TEXT,
      assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(guild_id, era_key)
    )
  `);

  // Add era column to battle_lobbies
  try { db.exec('ALTER TABLE battle_lobbies ADD COLUMN era TEXT DEFAULT "mafia"'); } catch (e) {}

  // Tenant-scoped verification role configs (tiers + trait rules)
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenant_role_configs (
      guild_id TEXT PRIMARY KEY,
      tiers_json TEXT DEFAULT '[]',
      traits_json TEXT DEFAULT '[]',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.prepare('INSERT OR IGNORE INTO ticket_sequences (name, value) VALUES (?, ?)').run('ticket', 0);

  // Role panels (multi-panel self-serve roles)
  db.exec(`
    CREATE TABLE IF NOT EXISTS role_panels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL DEFAULT '',
      channel_id TEXT,
      message_id TEXT,
      title TEXT DEFAULT '🎖️ Get Your Roles',
      description TEXT DEFAULT 'Click a button below to claim or unclaim a community role.',
      single_select INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS role_panel_roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      panel_id INTEGER NOT NULL REFERENCES role_panels(id) ON DELETE CASCADE,
      role_id TEXT NOT NULL,
      label TEXT,
      enabled INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      UNIQUE(panel_id, role_id)
    );
  `);
  try { db.exec('ALTER TABLE role_panels ADD COLUMN single_select INTEGER DEFAULT 0'); } catch (e) {}


  // ── Engagement & Points System (E1-E9) ───────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS points_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      username TEXT,
      action_type TEXT NOT NULL,
      points INTEGER NOT NULL DEFAULT 0,
      reference_id TEXT,
      note TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS points_totals (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      username TEXT,
      total_points INTEGER NOT NULL DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, user_id)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS action_cooldowns (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      action_type TEXT NOT NULL,
      last_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, user_id, action_type)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS shop_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      type TEXT NOT NULL DEFAULT 'role',
      cost INTEGER NOT NULL DEFAULT 100,
      role_id TEXT,
      code_pool TEXT DEFAULT '[]',
      quantity_remaining INTEGER DEFAULT -1,
      enabled INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS shop_redemptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      item_id INTEGER NOT NULL REFERENCES shop_items(id),
      cost INTEGER NOT NULL,
      fulfilled INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS engagement_config (
      guild_id TEXT PRIMARY KEY,
      enabled INTEGER DEFAULT 1,
      points_message INTEGER DEFAULT 5,
      points_reaction INTEGER DEFAULT 2,
      cooldown_message_mins INTEGER DEFAULT 60,
      cooldown_reaction_daily INTEGER DEFAULT 5,
      leaderboard_channel TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Unique dedup index for ledger
  try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_ref ON points_ledger (guild_id, user_id, reference_id) WHERE reference_id IS NOT NULL'); } catch (e) {}
  try { db.exec('ALTER TABLE points_ledger ADD COLUMN expired INTEGER DEFAULT 0'); } catch (e) {}

  // ── Wallet Tracker ─────────────────────────────────────────────────────────
  // Admin-defined wallets to monitor for TX alerts + live holdings panels
  db.exec(`
    CREATE TABLE IF NOT EXISTS tracked_wallets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      wallet_address TEXT NOT NULL,
      label TEXT,
      alert_channel_id TEXT,
      panel_channel_id TEXT,
      panel_message_id TEXT,
      enabled INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(guild_id, wallet_address)
    )
  `);
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_tracked_wallets_guild ON tracked_wallets(guild_id)'); } catch (e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_tracked_wallets_address ON tracked_wallets(wallet_address)'); } catch (e) {}
  try { db.exec('ALTER TABLE users ADD COLUMN total_tokens REAL DEFAULT 0'); } catch (e) {}

  // Token verification rules (tenant-scoped)
  db.exec(`
    CREATE TABLE IF NOT EXISTS token_role_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL DEFAULT '',
      token_mint TEXT NOT NULL,
      token_symbol TEXT,
      min_amount REAL NOT NULL DEFAULT 0,
      max_amount REAL,
      role_id TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(guild_id, token_mint, role_id)
    )
  `);
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_token_role_rules_guild ON token_role_rules(guild_id)'); } catch (e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_token_role_rules_mint ON token_role_rules(token_mint)'); } catch (e) {}

  // Token tracker config (tenant-scoped)
  db.exec(`
    CREATE TABLE IF NOT EXISTS tracked_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL DEFAULT '',
      token_mint TEXT NOT NULL,
      token_symbol TEXT,
      token_name TEXT,
      decimals INTEGER,
      enabled INTEGER DEFAULT 1,
      alert_channel_id TEXT,
      alert_buys INTEGER DEFAULT 1,
      alert_sells INTEGER DEFAULT 1,
      alert_transfers INTEGER DEFAULT 0,
      min_alert_amount REAL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(guild_id, token_mint)
    )
  `);
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_tracked_tokens_guild ON tracked_tokens(guild_id)'); } catch (e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_tracked_tokens_mint ON tracked_tokens(token_mint)'); } catch (e) {}
  try { db.exec('ALTER TABLE tracked_tokens ADD COLUMN alert_buys INTEGER DEFAULT 1'); } catch (e) {}
  try { db.exec('ALTER TABLE tracked_tokens ADD COLUMN alert_sells INTEGER DEFAULT 1'); } catch (e) {}
  try { db.exec('ALTER TABLE tracked_tokens ADD COLUMN alert_transfers INTEGER DEFAULT 0'); } catch (e) {}
  try { db.exec('ALTER TABLE tracked_tokens ADD COLUMN min_alert_amount REAL DEFAULT 0'); } catch (e) {}
  try { db.exec('ALTER TABLE tracked_tokens ADD COLUMN alert_channel_id TEXT'); } catch (e) {}

  // Cursor for per-wallet tracked token activity polling
  try { db.exec('ALTER TABLE tracked_wallets ADD COLUMN token_last_signature TEXT'); } catch (e) {}
  try { db.exec('ALTER TABLE tracked_wallets ADD COLUMN token_last_checked_at DATETIME'); } catch (e) {}

  // Token activity events captured for tracked wallets
  db.exec(`
    CREATE TABLE IF NOT EXISTS tracked_token_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL DEFAULT '',
      wallet_id INTEGER,
      wallet_address TEXT NOT NULL,
      token_mint TEXT NOT NULL,
      token_symbol TEXT,
      token_name TEXT,
      event_type TEXT NOT NULL,
      amount_delta REAL NOT NULL,
      balance_after REAL,
      sol_delta REAL,
      stable_delta REAL,
      tx_signature TEXT NOT NULL,
      event_time DATETIME,
      source TEXT DEFAULT 'poll',
      raw_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(wallet_id, tx_signature, token_mint)
    )
  `);
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_tracked_token_events_guild_time ON tracked_token_events(guild_id, event_time)'); } catch (e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_tracked_token_events_wallet_time ON tracked_token_events(wallet_id, event_time)'); } catch (e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_tracked_token_events_mint_time ON tracked_token_events(token_mint, event_time)'); } catch (e) {}

  logger.log('Database initialized successfully');
}

initDatabase();

function runMaintenance() {
  try {
    const result = db.pragma('integrity_check');
    if (result[0]?.integrity_check !== 'ok') {
      logger.error('[DB] Integrity check failed:', result);
    } else {
      logger.log('[DB] Integrity check passed');
    }
    db.exec('VACUUM');
    logger.log('[DB] Vacuum complete');
  } catch(e) {
    logger.error('[DB] Maintenance error:', e);
  }
}

module.exports = db;
module.exports.runMaintenance = runMaintenance;
