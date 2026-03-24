# Micro-Transfer Verification Deployment Notes

## Overview

This update adds an alternative wallet verification method via tiny SOL transfers. Users can verify wallet ownership by sending a unique, tiny SOL amount (e.g., 0.0000XYZ) to a monitored verification wallet instead of using wallet signature verification.

## What's New

### Features
- **Alternative verification method**: Users can choose between signature-based or micro-transfer verification
- **Automatic monitoring**: System polls Solana blockchain for incoming transfers
- **Auto-linking**: Verified wallets are automatically linked to Discord accounts
- **Rate limiting**: Built-in protection against abuse
- **Admin controls**: Full configuration via Discord commands
- **Web UI support**: Integrated into existing verify.html page
- **Discord notifications**: Users are DM'd when verification completes

### Files Added
- `services/microVerifyService.js` - Core service for micro-transfer verification
- `commands/verification/microVerify.js` - Discord command for users
- `commands/admin/microVerifyConfig.js` - Admin configuration command
- `test-micro-verify.js` - Test script for verification

### Files Modified
- `database/db.js` - Added `micro_verify_requests` table
- `index.js` - Added service initialization and button handlers
- `web/server.js` - Added API endpoints for web UI
- `web/public/verify.html` - Added UI for micro-transfer verification
- `.env.example` - Added configuration variables

## Database Changes

New table: `micro_verify_requests`
```sql
CREATE TABLE micro_verify_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  discord_id TEXT NOT NULL,
  username TEXT NOT NULL,
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
```

Indexes:
- `idx_micro_verify_discord_id` on `discord_id`
- `idx_micro_verify_status` on `status`
- `idx_micro_verify_amount` on `expected_amount`

## Configuration

### Environment Variables

Add to `.env`:
```bash
# Micro-Transfer Verification
MICRO_VERIFY_ENABLED=false
VERIFICATION_RECEIVE_WALLET=your_verification_wallet_address_here
VERIFY_REQUEST_TTL_MINUTES=15
POLL_INTERVAL_SECONDS=30
VERIFY_RATE_LIMIT_MINUTES=5
MAX_PENDING_PER_USER=1
```

### Configuration Options

| Variable | Description | Default | Recommended |
|----------|-------------|---------|-------------|
| `MICRO_VERIFY_ENABLED` | Enable/disable feature | `false` | `true` (after testing) |
| `VERIFICATION_RECEIVE_WALLET` | Solana address for receiving verification transfers | None | Set to dedicated wallet |
| `VERIFY_REQUEST_TTL_MINUTES` | How long verification request is valid | `15` | `15-30` |
| `POLL_INTERVAL_SECONDS` | Blockchain polling frequency | `30` | `30-60` |
| `VERIFY_RATE_LIMIT_MINUTES` | Cooldown between requests | `5` | `5-10` |
| `MAX_PENDING_PER_USER` | Max pending requests per user | `1` | `1` |

## Deployment Steps

### 1. Update Environment
```bash
# Add new variables to .env
nano .env

# Set at minimum:
MICRO_VERIFY_ENABLED=true
VERIFICATION_RECEIVE_WALLET=<YOUR_SOLANA_WALLET_ADDRESS>
```

### 2. Install Dependencies (if needed)
```bash
npm install
# All required packages (@solana/web3.js) are already in package.json
```

### 3. Test Database Migration
```bash
# The database migration runs automatically on startup
# Test it first:
node test-micro-verify.js
```

### 4. Deploy Commands
```bash
# Register new slash commands with Discord
node deploy-commands.js
```

### 5. Restart Bot
```bash
# Stop existing bot process
pm2 stop solpranos-bot

# Start with new code
pm2 start index.js --name solpranos-bot

# Check logs
pm2 logs solpranos-bot
```

### 6. Verify Startup
Look for these log messages:
```
[INFO] Database initialized successfully
[INFO] MicroVerifyService initialized
[INFO] Started micro-verify polling (interval: 30s)
```

### 7. Initial Configuration

Run in Discord as admin:
```
/micro-verify-config view
# Check current settings

/micro-verify-config enable enabled:true
# Enable the feature

/micro-verify-config wallet address:<YOUR_WALLET>
# Set verification wallet

/micro-verify-config stats
# View statistics
```

## Usage

### For Users

**Discord:**
```
/micro-verify
# Start verification process
# Follow instructions to send exact SOL amount
```

**Web:**
1. Visit `/verify` page
2. Click "Micro Transfer" button
3. Send exact amount shown to the address provided
4. Wait up to 30 seconds for automatic verification

### For Admins

**Configuration:**
```
/micro-verify-config view           # View current settings
/micro-verify-config enable true    # Enable feature
/micro-verify-config wallet <addr>  # Set receive wallet
/micro-verify-config ttl <minutes>  # Set expiry time
/micro-verify-config poll-interval <seconds>
/micro-verify-config stats          # View statistics
```

## Security & Abuse Prevention

### Built-in Protections
1. **Rate limiting**: Users can't spam requests (5 min cooldown)
2. **One-time use**: Each unique amount can only satisfy one request
3. **Auto-expiry**: Old requests expire automatically (15 min default)
4. **Max pending**: Users can only have 1 pending request at a time
5. **Exact matching**: Transfer must match expected amount exactly (±0.00000001 SOL tolerance)

### Best Practices
1. **Dedicated wallet**: Use a separate wallet just for verification transfers
2. **Monitor balance**: Check wallet balance periodically (users send ~0.00005 SOL each)
3. **Sweep funds**: Periodically transfer accumulated SOL to main treasury
4. **Check logs**: Monitor governance log channel for verification events
5. **Adjust rate limits**: Increase if spam, decrease if too restrictive

### Privacy
- The receive wallet address IS shown to users (required for them to send funds)
- Transaction signatures are logged for audit trail
- User wallets are only linked upon successful verification

## Monitoring

### Health Checks
```bash
# Check if polling is running
pm2 logs solpranos-bot | grep "polling"

# Check recent verifications
pm2 logs solpranos-bot | grep "Micro-verify"

# View stats in Discord
/micro-verify-config stats
```

### Expected Log Messages
```
[INFO] Started micro-verify polling (interval: 30s)
[INFO] Micro-verify request created: <discord_id> -> <amount> SOL
[INFO] Found X new transaction(s) to check
[INFO] Matched transaction <sig> to request <id>
[INFO] Micro-verify completed: <discord_id> -> <wallet> (<signature>)
[INFO] Expired X stale micro-verify request(s)
```

### Troubleshooting

**Polling not starting:**
- Check `MICRO_VERIFY_ENABLED=true` in .env
- Check `VERIFICATION_RECEIVE_WALLET` is set
- Check RPC connection: `SOLANA_RPC_URL`

**Transactions not detected:**
- Verify polling interval isn't too high
- Check RPC rate limits (use paid RPC if needed)
- Verify wallet address is correct
- Check transaction is confirmed (not just processed)

**Database errors:**
- Run test script: `node test-micro-verify.js`
- Check database schema: `sqlite3 database/solpranos.db ".schema micro_verify_requests"`
- Restart bot to run migrations

## Performance Considerations

### RPC Usage
- Polling interval of 30s = ~2,880 requests/day
- Each poll makes 1 `getSignaturesForAddress` call
- For high volume, use a paid RPC endpoint (e.g., Helius, QuickNode)

### Database Growth
- Each verification creates one row
- Expired requests remain for audit trail
- Cleanup old records periodically (add to maintenance schedule)

### Recommended Cleanup Query
```sql
-- Delete expired requests older than 30 days
DELETE FROM micro_verify_requests 
WHERE status = 'expired' 
AND created_at < datetime('now', '-30 days');
```

## Rollback Plan

If issues arise:

1. **Disable feature:**
   ```
   /micro-verify-config enable enabled:false
   ```

2. **Stop polling** (already stopped when disabled)

3. **Revert code** (if needed):
   ```bash
   git revert <commit-hash>
   pm2 restart solpranos-bot
   ```

4. **Users can still use** wallet signature verification (unchanged)

## Testing Checklist

- [ ] Database table created successfully
- [ ] Service initializes without errors
- [ ] Discord commands deploy successfully
- [ ] Web UI shows micro-verify button
- [ ] Test request creation (Discord)
- [ ] Test request creation (Web)
- [ ] Verify amount uniqueness
- [ ] Test rate limiting
- [ ] Test auto-expiry
- [ ] Test actual SOL transfer (testnet first!)
- [ ] Verify auto-linking works
- [ ] Check DM notifications
- [ ] Test admin config commands
- [ ] Verify governance logging
- [ ] Check backward compatibility (signature verify still works)

## Support

If you encounter issues:

1. Check bot logs: `pm2 logs solpranos-bot`
2. Run test script: `node test-micro-verify.js`
3. Check stats: `/micro-verify-config stats`
4. Verify configuration: `/micro-verify-config view`
5. Check Discord permissions (bot needs DM permission for notifications)

## Future Enhancements

Potential improvements (not in this release):
- [ ] Support other SPL tokens for verification
- [ ] Configurable amount range
- [ ] Webhook notifications
- [ ] Admin dashboard for pending requests
- [ ] Bulk expiry management
- [ ] Analytics and reporting
