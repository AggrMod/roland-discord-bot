const db = require('../database/db');
const vaultService = require('../services/vaultService');

async function run() {
  const guilds = db.prepare('SELECT guild_id FROM vault_configs LIMIT 1').all();
  if (!guilds.length) {
    console.log('No guild configured');
    return;
  }
  const guildId = guilds[0].guild_id;
  console.log('Running backfill for guild:', guildId);
  const res = await vaultService.backfillAllMissingMintTransfersForActiveSeason(guildId, { dryRun: true, limitPerWallet: 1000, delayMs: 0 });
  console.log(JSON.stringify(res.errors, null, 2));
}

run().catch(console.error);
