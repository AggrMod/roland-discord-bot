# Deployment Notes: Public API v1 Contract Polish

**Date:** 2024-03-24  
**Feature:** External API standardization for the-solpranos.com integration

## Overview

This deployment introduces versioned public API endpoints with standardized response envelopes, improved error handling, privacy safeguards, and comprehensive documentation.

## Changes Summary

### 1. **Standardized Response Envelope** ✅
- Created `utils/apiResponse.js` with standardized success/error formats
- All v1 endpoints return consistent shape:
  - `success` (boolean)
  - `data` (object/array)
  - `error` (null or structured object)
  - `meta` (version, timestamp, pagination where applicable)

### 2. **Enhanced Error Handling** ✅
- Created `utils/apiErrorHandler.js` with:
  - Async route wrapper (`asyncHandler`)
  - Global error handler middleware
  - 404 handler
  - Standardized error codes (BAD_REQUEST, NOT_FOUND, etc.)
- Integrated into web server at end of route chain

### 3. **API Versioning** ✅
- Created `/api/public/v1/...` endpoints in `web/routes/v1.js`
- Legacy endpoints remain for backward compatibility
- Version number embedded in meta field (1.0.0)

### 4. **Privacy & Security Hardening** ✅
- **Redacted IDs**: Discord IDs now redacted (e.g., `1234...5678`)
- **No wallet addresses**: Treasury endpoint strips raw wallet data
- **No NFT mints**: Mission participants don't expose mint addresses
- **Sensitive field sanitization**: `sanitize()` helper in apiResponse.js
- No access tokens, session IDs, or internal config values leaked

### 5. **CORS Configuration** ✅
- Explicit CORS setup for the-solpranos.com integration:
  - `https://the-solpranos.com`
  - `https://www.the-solpranos.com`
  - `http://localhost:3000` (dev)
  - `http://localhost:5173` (Vite dev)
- Methods: GET, POST, PUT, DELETE, OPTIONS
- Preflight cache: 24 hours
- Exposed headers for pagination (`X-Total-Count`)

### 6. **API Documentation** ✅
- Created `docs/API_PUBLIC_V1.md` with:
  - Complete endpoint schemas
  - Request/response examples
  - Error code reference
  - Privacy & security notes
  - Pagination guide
  - CORS details

### 7. **Contract Sanity Check Script** ✅
- Created `scripts/api-sanity-check.js`
- Tests all v1 endpoints for:
  - Response envelope structure
  - Required field presence
  - Data types
  - Privacy compliance (no sensitive leaks)
  - Error handling (404, validation errors)
  - CORS headers
- **Usage**: `node scripts/api-sanity-check.js [base-url]`

## Files Added/Modified

### Added:
- `utils/apiResponse.js` - Response envelope utilities
- `utils/apiErrorHandler.js` - Error handling middleware
- `web/routes/v1.js` - Versioned API routes
- `docs/API_PUBLIC_V1.md` - Public API documentation
- `scripts/api-sanity-check.js` - Contract validation script
- `DEPLOY_NOTES_API_V1.md` - This file

### Modified:
- `web/server.js`:
  - Enhanced CORS configuration (more explicit, better documented)
  - Mounted `/api/public/v1` routes
  - Added error handling middleware (404 + global error handler)

## Deployment Steps

### 1. Pre-Deployment Validation

```bash
# Navigate to project
cd /tmp/roland-discord-bot

# Install dependencies (if any new ones - none in this case)
npm install

# Run sanity check against local instance
# (Start bot first if not running)
node scripts/api-sanity-check.js http://localhost:3000
```

Expected output: All tests should pass ✅

### 2. Deployment

**Option A: Standard restart**
```bash
# Stop bot
pm2 stop roland-discord-bot

# Pull latest changes
git pull origin main

# Start bot
pm2 start roland-discord-bot
pm2 save
```

**Option B: Zero-downtime reload** (if using pm2 cluster mode)
```bash
git pull origin main
pm2 reload roland-discord-bot
```

### 3. Post-Deployment Validation

```bash
# Test against production
node scripts/api-sanity-check.js https://your-production-domain.com

# Verify specific endpoints manually
curl https://your-domain.com/api/public/v1/stats
curl https://your-domain.com/api/public/v1/proposals/active
curl https://your-domain.com/api/public/v1/treasury
```

### 4. Update External Integration

**Update the-solpranos.com frontend:**
- Switch API calls from `/api/public/*` to `/api/public/v1/*`
- Legacy endpoints still work but recommend migrating
- Check CORS errors in browser console (should be none)

## Breaking Changes

**None.** This is a fully backward-compatible deployment.

- Legacy `/api/public/*` endpoints remain operational
- New `/api/public/v1/*` endpoints available alongside
- Response format changes only affect v1 endpoints
- Existing integrations continue to work without modification

## Testing Checklist

- [ ] Sanity check script passes locally
- [ ] Sanity check script passes in production
- [ ] the-solpranos.com can fetch proposals
- [ ] the-solpranos.com can fetch treasury
- [ ] the-solpranos.com can fetch missions
- [ ] the-solpranos.com can fetch leaderboard
- [ ] No CORS errors in browser console
- [ ] No sensitive data visible in API responses (check browser network tab)
- [ ] Error responses are properly formatted (test invalid endpoints)
- [ ] Pagination works (test with `?limit=10&offset=0`)

## Rollback Plan

If issues arise:

```bash
# Revert to previous commit
git revert HEAD
pm2 restart roland-discord-bot
```

Or:

```bash
# Hard reset to previous version
git reset --hard <previous-commit-hash>
pm2 restart roland-discord-bot
```

Since legacy endpoints remain unchanged, external integrations will continue working even during rollback.

## Performance Impact

**Minimal.** Expected changes:
- Slight overhead from error handling middleware (~1-2ms per request)
- Additional JSON serialization for envelope wrapping (~0.5ms)
- No database query changes
- No new external API calls

**Recommendation:** Monitor response times for first 24 hours.

## Security Notes

### Privacy Improvements ✅
- Discord IDs now redacted in public responses
- Wallet addresses never exposed
- NFT mint addresses removed from public endpoints
- Internal database IDs not leaked

### CORS Policy ✅
- Whitelist approach (specific domains only)
- Credentials support enabled for authenticated endpoints
- Preflight caching reduces OPTIONS requests

### Validation ✅
- Query parameter limits enforced (max 100 items per page)
- Input validation for limit/offset parameters
- 404 for unknown routes (instead of exposing route structure)

## Monitoring Recommendations

1. **Error Logs**: Watch for error handler triggers
   ```bash
   pm2 logs roland-discord-bot --err
   ```

2. **API Usage**: Track v1 endpoint adoption
   - Monitor access logs for `/api/public/v1/*` vs `/api/public/*`
   - Identify when to deprecate legacy endpoints

3. **CORS Issues**: Check for rejected CORS preflight requests
   - Look for OPTIONS 403/404 responses

4. **Response Times**: Baseline and monitor
   ```bash
   # Test response time
   time curl https://your-domain.com/api/public/v1/stats
   ```

## Future Improvements

Potential enhancements for v1.1 or v2:

- [ ] Rate limiting (per-IP or per-API-key)
- [ ] API key authentication for external partners
- [ ] GraphQL endpoint alongside REST
- [ ] WebSocket support for real-time updates
- [ ] Response caching (Redis/Memcached)
- [ ] API analytics/usage tracking
- [ ] Deprecation warnings for legacy endpoints

## Support

**Questions or Issues:**
- Check `docs/API_PUBLIC_V1.md` for endpoint details
- Run sanity check script for validation
- Review error logs: `pm2 logs roland-discord-bot`

## Success Metrics

Within 7 days of deployment:

- [ ] Zero privacy/security incidents
- [ ] < 0.1% error rate on v1 endpoints
- [ ] the-solpranos.com successfully integrated
- [ ] No CORS-related support tickets
- [ ] All sanity checks passing in production

---

**Deployment Status:** ✅ Ready  
**Risk Level:** 🟢 Low (backward compatible)  
**Estimated Downtime:** None (or < 30 seconds for restart)
