# Treasury Watch - Quick Deploy Guide

## 🚀 Deployment Steps

### 1. Update Bot Commands
```bash
cd /tmp/roland-discord-bot
node deploy-commands.js
```

### 2. Restart Bot
```bash
# If using PM2:
pm2 restart solpranos-bot

# If running manually:
# Stop current process (Ctrl+C)
node index.js
```

### 3. Configure Treasury (Discord Admin Commands)
```bash
# Set wallet to monitor
/treasury set-wallet address:YOUR_SOLANA_WALLET_HERE

# Set refresh interval (optional, defaults to 4 hours)
/treasury set-interval hours:4

# Enable monitoring
/treasury enable

# Fetch initial balances
/treasury refresh

# Check status
/treasury status
```

## ✅ Verify Deployment

### Discord
Run `/treasury status` - should show:
- ✅ Enabled: Yes
- 💰 Balances displayed
- 🔐 Wallet masked (DRpb...21hy format)

### Web Portal (Admin)
1. Login at `http://your-domain:3000/`
2. Navigate to Admin section
3. See "💰 Treasury Watch" card with balances

### Public API Test
```bash
curl http://your-domain:3000/api/public/treasury
```

Should return balances WITHOUT wallet address.

## 🔒 Security Validation

**Critical: Verify wallet is NOT exposed publicly**

```bash
# This should NOT contain your wallet address:
curl http://your-domain:3000/api/public/treasury | grep -i "YOUR_WALLET"
# (Should output nothing)

# This SHOULD contain masked wallet (admin only):
curl -H "Cookie: your-admin-session" http://your-domain:3000/api/admin/treasury
# (Shows DRpb...21hy format)
```

## 📋 Environment Variables

**Optional:** Add to `.env` for custom RPC:
```bash
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
```

## 🧪 Testing

Run test script:
```bash
node test-treasury.js
```

Expected: All ✅ green checks, no ❌ failures.

## 📊 What Users See

### Regular Users (Dashboard)
- **DAO Treasury** card
- SOL balance: `368.3183`
- USDC balance: `1250.00`
- Last updated timestamp
- ❌ NO wallet address

### Admins Only
- Everything users see, PLUS:
- Masked wallet: `DRpb...21hy`
- Refresh interval
- Enable/disable status
- Manual refresh button
- Error messages (if any)

## 🔄 Auto-Refresh

Once configured, treasury balances refresh automatically every X hours (default: 4).

Scheduler starts automatically when bot starts (if enabled).

## 🛠️ Troubleshooting

**Balances not updating?**
```bash
/treasury refresh  # Manual trigger
/treasury status   # Check last error
```

**Scheduler not running?**
- Check bot startup logs for: `⏰ Treasury auto-refresh started`
- Ensure treasury is enabled: `/treasury enable`
- Verify wallet is configured: `/treasury status`

**RPC errors?**
- Set custom RPC in `.env`
- Increase refresh interval to reduce calls

## 📦 Dependencies

✅ No new dependencies required! (Already in package.json)

## ⚡ Zero Downtime Notes

- Safe to deploy during operation
- Database migration automatic (creates table if missing)
- Backward compatible (no breaking changes)
- Users won't see treasury until admin enables it

---

**Status:** ✅ Ready for Production  
**Commits:** 
- `4a27a4d` - Treasury Watch implementation
- `a5d821e` - Deployment notes

**Next Steps:**
1. Deploy commands
2. Restart bot
3. Configure via `/treasury` commands
4. Monitor initial fetch
5. Verify security (no wallet leakage)
