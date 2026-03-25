# 🚀 Solpranos Bot Deployment Guide

## Pre-Deployment Checklist

### 1. Discord OAuth2 Setup (Required for Portal Login)
Go to [Discord Developer Portal](https://discord.com/developers/applications):
1. Select your application
2. **OAuth2 > General**:
   - Copy `CLIENT_ID` → add to `.env` as `CLIENT_ID=...`
   - Copy `CLIENT_SECRET` → add to `.env` as `DISCORD_CLIENT_SECRET=...`
3. **OAuth2 > Redirects**:
   - Add your redirect URI (e.g., `https://discordbot.the-solpranos.com/auth/discord/callback`)
   - Add to `.env` as `DISCORD_REDIRECT_URI=...` (must match EXACTLY)

### 2. Environment Variables
Copy `.env.example` to `.env` and fill in:

```bash
cp .env.example .env
nano .env  # or use your editor
```

**Critical variables**:
- `DISCORD_TOKEN` - Bot token (from Discord Developer Portal > Token)
- `CLIENT_ID` - From OAuth2 > General
- `GUILD_ID` - Your Discord server ID
- `DISCORD_CLIENT_SECRET` - From OAuth2 > General
- `DISCORD_REDIRECT_URI` - From OAuth2 > Redirects (must match EXACTLY)
- `SESSION_SECRET` - Generate random string (e.g., `openssl rand -base64 32`)

**Optional (but recommended)**:
- `HELIUS_API_KEY` - Get from https://www.helius.dev/ (for real Solana NFT verification)
- `NODE_ENV=production` - For HTTPS-only cookies in production

### 3. Real NFT Verification
**Default behavior** (MOCK_MODE disabled as of v1.1.0):
- System tries to fetch real NFTs from Solana via Helius API
- If Helius API key not set or unavailable, falls back to mock data
- Set `HELIUS_API_KEY` to enable real verification

**To use mock data** (testing only):
```bash
# In .env
MOCK_MODE=true
```

## Deployment Steps

### First-Time Deployment
```bash
cd ~/roland-discord-bot

# 1. Get latest code
git pull origin main

# 2. Install/update dependencies (includes session store)
npm install

# 3. Deploy slash commands to Discord
node deploy-commands.js

# 4. Start bot with pm2
pm2 start index.js --name roland-bot
pm2 save

# 5. Start web server (if not running via bot)
# Optional: web server runs on port 3000
# To expose: use Nginx/Apache reverse proxy or ngrok for testing
```

### Updating After Changes
```bash
cd ~/roland-discord-bot
git pull origin main
npm install
node deploy-commands.js
pm2 restart roland-bot
```

### Restarting Bot
```bash
pm2 restart roland-bot
```

### Viewing Logs
```bash
pm2 logs roland-bot
```

## Verification

### 1. Portal Login Test
1. Visit `https://discordbot.the-solpranos.com` (or your bot URL)
2. Click "Verify" button
3. Should redirect to Discord OAuth login
4. After login, should show dashboard
5. **Expected**: No `error=no_token` in URL

### 2. NFT Verification Test
```bash
# Run in Discord server where bot is active
/verification status
```

**Expected output**:
- If HELIUS_API_KEY set: Shows real Solana NFTs for linked wallets
- If Helius unavailable: Shows mock NFTs (random data)
- If no wallets linked: Prompts to verify wallet

### 3. Session Persistence Test
```bash
pm2 restart roland-bot
# Visit portal, should still be logged in (session persists)
```

### 4. Trait Roles Test
```bash
/verification admin role-config view
```

**Expected**: Shows current trait-to-role mappings

## Troubleshooting

### Portal Login Fails (`error=no_token`)
1. **Check**: DISCORD_CLIENT_SECRET is set in .env
2. **Check**: DISCORD_REDIRECT_URI matches Discord Developer Portal exactly
3. **Check**: OAuth2 redirect URL is HTTPS in production
4. **Logs**: Check `pm2 logs roland-bot` for token exchange errors

### Sessions Lost After Restart
- ✅ Fixed in v1.1.0 (now uses persistent SQLite store)
- Verify: `database/sessions.db` file exists after restart

### NFTs Showing As Mock Data
1. **Check**: HELIUS_API_KEY is set in .env
2. **Check**: MOCK_MODE is NOT `true` in .env
3. **Logs**: Check for "Helius fetch error" in bot logs

### Role-Config Command Shows Stub Text
- **Check**: You're running v1.1.0 or later
- **Update**: `git pull origin main && npm install && pm2 restart roland-bot`

## Production Checklist

- [ ] OAuth2 configured in Discord Developer Portal
- [ ] All required env vars set (.env file)
- [ ] HELIUS_API_KEY configured (for real NFT verification)
- [ ] NODE_ENV=production set
- [ ] SESSION_SECRET is random/secure (not hardcoded)
- [ ] HTTPS enabled for web domain
- [ ] bot running with pm2
- [ ] Web server accessible at your domain
- [ ] /verification admin panel posted to guild
- [ ] Trait roles configured (web admin panel)
- [ ] Tested portal login (OAuth flow)
- [ ] Tested /verification status (NFT fetch)
- [ ] Tested session persistence (restart test)

## Support

For issues:
1. Check logs: `pm2 logs roland-bot`
2. Verify .env variables
3. Check Discord Developer Portal settings match .env
4. Ensure bot has necessary permissions in Discord server

---

**Last Updated**: 2026-03-25 (v1.1.0 - Critical Fixes)
