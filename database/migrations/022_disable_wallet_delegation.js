module.exports = {
  version: 22,
  name: 'disable_wallet_delegation',
  up: ({ db, logger }) => {
    db.exec(`
      UPDATE tenant_verification_settings
      SET include_delegated_wallets = 0,
          updated_at = CURRENT_TIMESTAMP
      WHERE include_delegated_wallets != 0
    `);
    logger.log('[migration] 022 disabled wallet delegation for V1 security review');
  },
};
