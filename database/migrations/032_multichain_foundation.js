function hasColumn(db, tableName, columnName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all()
    .some(column => String(column.name || '').toLowerCase() === String(columnName).toLowerCase());
}

module.exports = {
  version: 32,
  name: 'multichain_foundation',
  up: ({ db, logger }) => {
    if (!hasColumn(db, 'wallets', 'chain_family')) {
      db.exec(`
        ALTER TABLE wallets RENAME TO wallets_pre_multichain;
        CREATE TABLE wallets (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          discord_id TEXT NOT NULL,
          chain_family TEXT NOT NULL DEFAULT 'solana',
          chain_id TEXT NOT NULL DEFAULT 'solana:mainnet',
          wallet_address TEXT NOT NULL,
          verified BOOLEAN DEFAULT 1,
          primary_wallet BOOLEAN DEFAULT 0,
          is_favorite BOOLEAN DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (discord_id) REFERENCES users(discord_id),
          UNIQUE(chain_family, wallet_address)
        );
        INSERT INTO wallets (id, discord_id, chain_family, chain_id, wallet_address, verified, primary_wallet, is_favorite, created_at)
        SELECT id, discord_id, 'solana', 'solana:mainnet', wallet_address, verified, primary_wallet, is_favorite, created_at
        FROM wallets_pre_multichain;
        DROP TABLE wallets_pre_multichain;
      `);
    }

    if (!hasColumn(db, 'tracked_wallets', 'chain_family')) {
      db.exec(`
        ALTER TABLE tracked_wallets RENAME TO tracked_wallets_pre_multichain;
        CREATE TABLE tracked_wallets (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          guild_id TEXT NOT NULL,
          chain_family TEXT NOT NULL DEFAULT 'solana',
          chain_id TEXT NOT NULL DEFAULT 'solana:mainnet',
          wallet_address TEXT NOT NULL,
          label TEXT,
          alert_channel_id TEXT,
          panel_channel_id TEXT,
          panel_message_id TEXT,
          enabled INTEGER DEFAULT 1,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          token_last_signature TEXT,
          token_last_checked_at DATETIME,
          UNIQUE(guild_id, chain_id, wallet_address)
        );
        INSERT INTO tracked_wallets (
          id, guild_id, chain_family, chain_id, wallet_address, label, alert_channel_id,
          panel_channel_id, panel_message_id, enabled, created_at, updated_at,
          token_last_signature, token_last_checked_at
        )
        SELECT id, guild_id, 'solana', 'solana:mainnet', wallet_address, label, alert_channel_id,
          panel_channel_id, panel_message_id, enabled, created_at, updated_at,
          token_last_signature, token_last_checked_at
        FROM tracked_wallets_pre_multichain;
        DROP TABLE tracked_wallets_pre_multichain;
      `);
    }

    if (!hasColumn(db, 'tracked_tokens', 'chain_family')) {
      db.exec(`
        ALTER TABLE tracked_tokens RENAME TO tracked_tokens_pre_multichain;
        CREATE TABLE tracked_tokens (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          guild_id TEXT NOT NULL DEFAULT '',
          chain_family TEXT NOT NULL DEFAULT 'solana',
          chain_id TEXT NOT NULL DEFAULT 'solana:mainnet',
          token_mint TEXT NOT NULL,
          token_symbol TEXT,
          token_name TEXT,
          decimals INTEGER,
          enabled INTEGER DEFAULT 1,
          alert_channel_id TEXT,
          alert_channel_ids TEXT DEFAULT '[]',
          alert_buys INTEGER DEFAULT 1,
          alert_sells INTEGER DEFAULT 1,
          alert_transfers INTEGER DEFAULT 0,
          min_alert_amount REAL DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(guild_id, chain_id, token_mint)
        );
        INSERT INTO tracked_tokens (
          id, guild_id, chain_family, chain_id, token_mint, token_symbol, token_name,
          decimals, enabled, alert_channel_id, alert_channel_ids, alert_buys, alert_sells,
          alert_transfers, min_alert_amount, created_at, updated_at
        )
        SELECT id, guild_id, 'solana', 'solana:mainnet', token_mint, token_symbol, token_name,
          decimals, enabled, alert_channel_id, alert_channel_ids, alert_buys, alert_sells,
          alert_transfers, min_alert_amount, created_at, updated_at
        FROM tracked_tokens_pre_multichain;
        DROP TABLE tracked_tokens_pre_multichain;
      `);
    }

    if (!hasColumn(db, 'nft_tracked_collections', 'chain_family')) {
      db.exec(`
        ALTER TABLE nft_tracked_collections RENAME TO nft_tracked_collections_pre_multichain;
        CREATE TABLE nft_tracked_collections (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          guild_id TEXT NOT NULL DEFAULT '',
          chain_family TEXT NOT NULL DEFAULT 'solana',
          chain_id TEXT NOT NULL DEFAULT 'solana:mainnet',
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
          me_symbol TEXT DEFAULT '',
          track_bid INTEGER DEFAULT 0,
          UNIQUE(guild_id, chain_id, collection_address)
        );
        INSERT INTO nft_tracked_collections (
          id, guild_id, chain_family, chain_id, collection_address, collection_name, channel_id,
          track_mint, track_sale, track_list, track_delist, track_transfer, enabled, created_at,
          me_symbol, track_bid
        )
        SELECT id, guild_id, 'solana', 'solana:mainnet', collection_address, collection_name, channel_id,
          track_mint, track_sale, track_list, track_delist, track_transfer, enabled, created_at,
          me_symbol, track_bid
        FROM nft_tracked_collections_pre_multichain;
        DROP TABLE nft_tracked_collections_pre_multichain;
      `);
    }

    if (!hasColumn(db, 'token_role_rules', 'chain_family')) {
      db.exec(`
        ALTER TABLE token_role_rules RENAME TO token_role_rules_pre_multichain;
        CREATE TABLE token_role_rules (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          guild_id TEXT NOT NULL DEFAULT '',
          chain_family TEXT NOT NULL DEFAULT 'solana',
          chain_id TEXT NOT NULL DEFAULT 'solana:mainnet',
          token_mint TEXT NOT NULL,
          token_symbol TEXT,
          min_amount REAL NOT NULL DEFAULT 0,
          max_amount REAL,
          role_id TEXT NOT NULL,
          enabled INTEGER DEFAULT 1,
          never_remove INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(guild_id, chain_id, token_mint, role_id)
        );
        INSERT INTO token_role_rules (
          id, guild_id, chain_family, chain_id, token_mint, token_symbol, min_amount,
          max_amount, role_id, enabled, never_remove, created_at, updated_at
        )
        SELECT id, guild_id, 'solana', 'solana:mainnet', token_mint, token_symbol, min_amount,
          max_amount, role_id, enabled, never_remove, created_at, updated_at
        FROM token_role_rules_pre_multichain;
        DROP TABLE token_role_rules_pre_multichain;
      `);
    }

    if (!hasColumn(db, 'wallet_verification_challenges', 'chain_id')) {
      db.exec("ALTER TABLE wallet_verification_challenges ADD COLUMN chain_id TEXT NOT NULL DEFAULT 'solana:mainnet'");
    }
    for (const table of ['tracked_token_events', 'nft_activity_events']) {
      if (!hasColumn(db, table, 'chain_family')) db.exec(`ALTER TABLE ${table} ADD COLUMN chain_family TEXT NOT NULL DEFAULT 'solana'`);
      if (!hasColumn(db, table, 'chain_id')) db.exec(`ALTER TABLE ${table} ADD COLUMN chain_id TEXT NOT NULL DEFAULT 'solana:mainnet'`);
    }
    if (!hasColumn(db, 'tracked_token_events', 'amount_raw')) {
      db.exec('ALTER TABLE tracked_token_events ADD COLUMN amount_raw TEXT');
    }

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_wallets_discord_id ON wallets(discord_id);
      CREATE INDEX IF NOT EXISTS idx_wallets_chain_address ON wallets(chain_family, wallet_address);
      CREATE INDEX IF NOT EXISTS idx_tracked_wallets_guild ON tracked_wallets(guild_id);
      CREATE INDEX IF NOT EXISTS idx_tracked_wallets_chain_address ON tracked_wallets(chain_id, wallet_address);
      CREATE INDEX IF NOT EXISTS idx_tracked_tokens_guild ON tracked_tokens(guild_id);
      CREATE INDEX IF NOT EXISTS idx_tracked_tokens_chain_contract ON tracked_tokens(chain_id, token_mint);
      CREATE INDEX IF NOT EXISTS idx_nft_collections_chain_contract ON nft_tracked_collections(chain_id, collection_address);
      CREATE INDEX IF NOT EXISTS idx_token_role_rules_chain_contract ON token_role_rules(chain_id, token_mint);
      CREATE TABLE IF NOT EXISTS evm_tracker_cursors (
        guild_id TEXT NOT NULL,
        chain_id TEXT NOT NULL,
        tracker_type TEXT NOT NULL,
        tracker_id INTEGER NOT NULL,
        last_block INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        checked_at DATETIME,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (guild_id, chain_id, tracker_type, tracker_id)
      );
    `);
    logger.log('[DB] Migration v32 added the multi-chain wallet, NFT, token, and tracker foundation');
  },
};
