# API v1 Polish - Deploy Summary

## ✅ Completed

### Core Deliverables
1. **Standardized Response Envelope** (`utils/apiResponse.js`)
   - Consistent shape: `success`, `data`, `error`, `meta`
   - Version tracking (1.0.0) and timestamps
   - Pagination metadata support

2. **API Versioning** (`web/routes/v1.js`)
   - New endpoints: `/api/public/v1/*`
   - All existing endpoints maintained for backward compatibility
   - Versioned routes:
     - `GET /proposals/active`
     - `GET /proposals/concluded` (with pagination)
     - `GET /proposals/:id`
     - `GET /stats`
     - `GET /treasury`
     - `GET /missions/active`
     - `GET /missions/completed` (with pagination)
     - `GET /missions/:id`
     - `GET /leaderboard` (with limit)
     - `GET /leaderboard/:userId`

3. **Privacy & Security Hardening**
   - Discord IDs redacted (format: `1234...5678`)
   - Wallet addresses removed from public endpoints
   - NFT mint addresses removed
   - Sensitive field sanitization helper (`sanitize()`)

4. **Enhanced Error Handling** (`utils/apiErrorHandler.js`)
   - Standardized error codes (BAD_REQUEST, NOT_FOUND, etc.)
   - Global error handler middleware
   - 404 handler for unknown routes
   - Async route wrapper for cleaner error catching

5. **CORS Configuration** (updated in `web/server.js`)
   - Explicit whitelist for guildpilot.app
   - Methods: GET, POST, PUT, DELETE, OPTIONS
   - 24-hour preflight cache
   - Credentials support enabled

6. **API Documentation** (`docs/API_PUBLIC_V1.md`)
   - Complete endpoint schemas
   - Request/response examples
   - Error code reference
   - Privacy & security notes
   - Pagination guide

7. **Contract Sanity Check** (`scripts/api-sanity-check.js`)
   - Validates response envelope structure
   - Checks for privacy leaks (IDs, wallets)
   - Tests error handling (404, validation)
   - Usage: `node scripts/api-sanity-check.js [base-url]`

## 📝 Deploy Instructions

### Quick Deploy
```bash
# 1. Pull latest
cd /path/to/roland-discord-bot
git pull origin main

# 2. Restart bot
pm2 restart roland-discord-bot

# 3. Validate
node scripts/api-sanity-check.js http://localhost:3000
```

### Validation
```bash
# Test v1 endpoints
curl http://localhost:3000/api/public/v1/stats
curl http://localhost:3000/api/public/v1/proposals/active
curl http://localhost:3000/api/public/v1/treasury
```

## 🚨 Important Notes

### No Breaking Changes ✅
- Legacy endpoints (`/api/public/*`) still work
- Existing integrations unaffected
- v1 endpoints are additive

### Route Changes
- **New**: `/api/public/v1/*` routes mounted
- **Changed**: `web/server.js` CORS config enhanced
- **Added**: Error handling middleware at end of route chain

### Restart Required
**Yes** - Server restart needed to load:
- New v1 routes
- Error handling middleware
- Enhanced CORS config

Estimated downtime: **< 30 seconds** (pm2 restart)

### Post-Deploy Testing
1. Run sanity check script (all tests should pass)
2. Check no sensitive data in responses:
   ```bash
   curl http://localhost:3000/api/public/v1/treasury | jq .
   # Should NOT contain "wallet" field
   ```
3. Verify CORS from browser (guildpilot.app)
4. Test pagination:
   ```bash
   curl "http://localhost:3000/api/public/v1/proposals/concluded?limit=10"
   ```

## 📊 Success Metrics

After deployment:
- [ ] Sanity check passes (100% tests green)
- [ ] No privacy leaks (no raw wallet addresses, unredacted IDs)
- [ ] CORS working (no console errors from guildpilot.app)
- [ ] Error responses properly formatted
- [ ] Legacy endpoints still operational

## 🔄 Rollback

If needed:
```bash
git revert HEAD
pm2 restart roland-discord-bot
```

Since legacy endpoints unchanged, rollback is safe.

---

**Commit:** `22f5b58` - "API polish: public v1 contract, response standardization, docs"  
**Risk:** 🟢 Low (backward compatible)  
**Impact:** Public API consumers (guildpilot.app)
