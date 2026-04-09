const db = require('./database/db');

const suffix = Date.now();
const guildA = `guildA_${suffix}`;
const guildB = `guildB_${suffix}`;
const userA = `userA_${suffix}`;
const userB = `userB_${suffix}`;

function cleanup() {
  db.prepare('DELETE FROM user_tenant_memberships WHERE discord_id IN (?, ?)').run(userA, userB);
  db.prepare('DELETE FROM wallets WHERE discord_id IN (?, ?)').run(userA, userB);
  db.prepare('DELETE FROM users WHERE discord_id IN (?, ?)').run(userA, userB);
}

try {
  cleanup();

  db.prepare(`
    INSERT INTO users (discord_id, username, total_nfts, tier, voting_power, total_tokens)
    VALUES (?, ?, 5, 'TierA', 10, 100), (?, ?, 3, 'TierB', 5, 50)
  `).run(userA, 'User A', userB, 'User B');

  db.prepare(`
    INSERT INTO wallets (discord_id, wallet_address, verified, primary_wallet, is_favorite)
    VALUES (?, ?, 1, 1, 0), (?, ?, 1, 1, 0)
  `).run(userA, `WalletA_${suffix}`, userB, `WalletB_${suffix}`);

  db.prepare(`
    INSERT INTO user_tenant_memberships (discord_id, guild_id, source, last_verified_at)
    VALUES (?, ?, 'test', CURRENT_TIMESTAMP), (?, ?, 'test', CURRENT_TIMESTAMP)
  `).run(userA, guildA, userB, guildB);

  const scopedA = db.prepare(`
    SELECT u.discord_id
    FROM user_tenant_memberships um
    INNER JOIN users u ON u.discord_id = um.discord_id
    WHERE um.guild_id = ?
    ORDER BY u.discord_id
  `).all(guildA).map(row => row.discord_id);

  const scopedB = db.prepare(`
    SELECT u.discord_id
    FROM user_tenant_memberships um
    INNER JOIN users u ON u.discord_id = um.discord_id
    WHERE um.guild_id = ?
    ORDER BY u.discord_id
  `).all(guildB).map(row => row.discord_id);

  if (scopedA.length !== 1 || scopedA[0] !== userA) {
    throw new Error(`Expected only ${userA} in guild A scope, got ${JSON.stringify(scopedA)}`);
  }

  if (scopedB.length !== 1 || scopedB[0] !== userB) {
    throw new Error(`Expected only ${userB} in guild B scope, got ${JSON.stringify(scopedB)}`);
  }

  const removed = db.prepare('DELETE FROM user_tenant_memberships WHERE discord_id = ? AND guild_id = ?').run(userA, guildA);
  if (removed.changes !== 1) {
    throw new Error('Expected tenant-scoped membership delete to remove exactly 1 row');
  }

  const remainingUser = db.prepare('SELECT discord_id FROM users WHERE discord_id = ?').get(userA);
  if (!remainingUser) {
    throw new Error('Tenant-scoped removal should not delete global user profile');
  }

  console.log('Admin user tenant-scoping assertions passed');
} finally {
  cleanup();
}
