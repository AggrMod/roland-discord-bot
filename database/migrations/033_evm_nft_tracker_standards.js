function hasColumn(db, tableName, columnName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all()
    .some(column => String(column.name || '').toLowerCase() === String(columnName).toLowerCase());
}

module.exports = {
  version: 33,
  name: 'evm_nft_tracker_standards',
  up: ({ db, logger }) => {
    if (!hasColumn(db, 'nft_tracked_collections', 'nft_standard')) {
      db.exec("ALTER TABLE nft_tracked_collections ADD COLUMN nft_standard TEXT NOT NULL DEFAULT 'solana'");
    }
    if (!hasColumn(db, 'nft_tracked_collections', 'token_id')) {
      db.exec('ALTER TABLE nft_tracked_collections ADD COLUMN token_id TEXT');
    }
    db.exec(`
      UPDATE nft_tracked_collections
      SET nft_standard = CASE WHEN chain_family = 'evm' THEN 'erc721' ELSE 'solana' END
      WHERE nft_standard IS NULL OR nft_standard = '' OR (chain_family = 'evm' AND nft_standard = 'solana');
    `);
    logger.log('[DB] Migration v33 added ERC-721 and ERC-1155 tracker configuration');
  },
};
