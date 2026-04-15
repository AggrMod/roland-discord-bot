const Database = require('better-sqlite3');
const path = require('path');

async function debugOG() {
  const dbPath = path.join(__dirname, 'database', 'solpranos.db');
  const db = new Database(dbPath);
  
  console.log('--- DB: solpranos.db ---');
  
  const tenants = db.prepare('SELECT id, guild_id, guild_name FROM tenants').all();
  const cartoonTenant = tenants.find(t => t.guild_name && t.guild_name.toLowerCase().includes('cartoon'));
  
  if (cartoonTenant) {
    console.log('Found Cartoon Maffia Tenant:', JSON.stringify(cartoonTenant, null, 2));
    const settings = db.prepare('SELECT * FROM tenant_verification_settings WHERE tenant_id = ?').get(cartoonTenant.id);
    console.log('Verification Settings:', JSON.stringify(settings, null, 2));
    
    // Check how many people are verified in this guild vs globally
    const globalVerified = db.prepare(`
      SELECT COUNT(DISTINCT u.discord_id) as count
      FROM users u
      JOIN wallets w ON u.discord_id = w.discord_id
    `).get().count;
    console.log('Global Verified Users:', globalVerified);

    // Get the first 15 verified users globally
    const topVerified = db.prepare(`
      SELECT u.discord_id, u.username, MIN(w.created_at) AS first_verified_at
      FROM users u
      JOIN wallets w ON u.discord_id = w.discord_id
      GROUP BY u.discord_id
      ORDER BY first_verified_at ASC
      LIMIT 15
    `).all();
    console.log('Top 15 Verified Users (Global):', JSON.stringify(topVerified, null, 2));
  } else {
    console.log('Cartoon Maffia Tenant not found in solpranos.db');
    // List some tenants to see what names they have
    console.log('Tenants Sample:', JSON.stringify(tenants.slice(0, 10), null, 2));
  }
}

debugOG().catch(console.error);
