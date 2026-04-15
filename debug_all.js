const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

async function debugAll() {
  const dbs = ['guildpilot.db', 'solpranos.db'];
  
  for (const dbName of dbs) {
    const dbPath = path.join(__dirname, 'database', dbName);
    if (!fs.existsSync(dbPath)) continue;
    
    console.log(`\n=== DB: ${dbName} ===`);
    const db = new Database(dbPath);
    
    const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get();
    const walletCount = db.prepare('SELECT COUNT(*) as count FROM wallets').get();
    console.log(`Users: ${userCount.count}, Wallets: ${walletCount.count}`);

    const tenants = db.prepare('SELECT id, guild_id, guild_name FROM tenants').all();
    const targetTenant = tenants.find(t => t.guild_name && (t.guild_name.toLowerCase().includes('cartoon') || t.guild_name.toLowerCase().includes('maffia')));
    
    if (targetTenant) {
      console.log('Found Target Tenant:', JSON.stringify(targetTenant, null, 2));
      const settings = db.prepare('SELECT * FROM tenant_verification_settings WHERE tenant_id = ?').get(targetTenant.id);
      console.log('Verification Settings:', JSON.stringify(settings, null, 2));
      
      const guildWallets = db.prepare(`
        SELECT w.*, u.username
        FROM wallets w
        JOIN users u ON w.discord_id = u.discord_id
        WHERE EXISTS (SELECT 1 FROM tenants t WHERE t.id = ? AND t.guild_id != "")
      `).all(targetTenant.id);
      
      console.log(`Wallets in Guild (approx): ${guildWallets.length}`);
    } else {
      console.log('Cartoon Maffia Tenant not explicitly named.');
      // Find the tenant with the most activity or most recent update
      const activeTenants = db.prepare('SELECT * FROM tenants ORDER BY updated_at DESC LIMIT 5').all();
      console.log('Recent Tenants:', JSON.stringify(activeTenants, null, 2));
    }
  }
}

debugAll().catch(console.error);
