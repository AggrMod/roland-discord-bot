const db = require('./database/db.js');
const vaultService = require('./services/vaultService.js');

const guildId = 'test_guild';
const seasonId = 'season_1';

db.prepare('DELETE FROM vault_config WHERE guild_id = ?').run(guildId);
db.prepare('DELETE FROM vault_mint_events WHERE guild_id = ?').run(guildId);

db.prepare(`
  INSERT INTO vault_config (guild_id, config_json)
  VALUES (?, ?)
`).run(guildId, JSON.stringify({
  keyTiers: [
    { id: 'gold', name: 'Gold', enabled: true },
    { id: 'silver', name: 'Silver', enabled: true },
    { id: 'bronze', name: 'Bronze', enabled: true }
  ],
  minting: {
    paymentBands: [
      { keyTier: 'bronze', minLamports: 1, maxLamports: 49999999, paid: 1, free: 0 },
      { keyTier: 'silver', minLamports: 50000000, maxLamports: 99999999, paid: 1, free: 0 },
      { keyTier: 'gold', minLamports: 100000000, maxLamports: null, paid: 1, free: 0 }
    ],
    grantsPerMint: { gold: { paid: 1, free: 0, pressure: 0 } }
  }
}));

// Test 0.04 SOL (Bronze)
const resultBronze = vaultService.computeMintGrants(
  vaultService.getConfig(guildId), 'paid', { transferLamports: 40000000 }
);
console.log('0.04 SOL ->', resultBronze.key_tier_grants);

// Test 0.05 SOL (Silver)
const resultSilver = vaultService.computeMintGrants(
  vaultService.getConfig(guildId), 'paid', { transferLamports: 50000000 }
);
console.log('0.05 SOL ->', resultSilver.key_tier_grants);

// Test 0.1 SOL (Gold)
const resultGold = vaultService.computeMintGrants(
  vaultService.getConfig(guildId), 'paid', { transferLamports: 100000000 }
);
console.log('0.1 SOL ->', resultGold.key_tier_grants);
