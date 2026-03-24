# Governance Bundle Deployment Notes

## Summary
Implemented three governance correctness features:
1. ✅ Block proposal creator from supporting own proposal
2. ✅ Auto-expire draft proposals after 7 days if support threshold not met
3. ✅ Add governance audit logging to dedicated channel

## Changes Made

### New Files
- `utils/governanceLogger.js` - Centralized governance audit logging utility

### Modified Files
- `.env.example` - Added GOVERNANCE_LOG_CHANNEL_ID
- `services/proposalService.js` - Added self-support blocking, draft expiry logic, and audit logging
- `index.js` - Integrated governanceLogger, added expiry checks to periodic interval
- `commands/governance/propose.js` - Uses configurable support threshold from settings.json
- `commands/governance/support.js` - Uses configurable support threshold from settings.json

### Database Changes
- No schema changes required (uses existing fields)
- Proposals can now have status='expired' for draft proposals that expire

## Environment Setup

### Required: Add to .env file
```bash
GOVERNANCE_LOG_CHANNEL_ID=your_governance_log_channel_id_here
```

### Optional: Configure in config/settings.json
```json
{
  "supportThreshold": 4,  // Already set - number of supporters needed to promote draft to voting
  ...
}
```

## Feature Details

### 1. Self-Support Block
- Enforced in `proposalService.addSupporter()`
- Works for both `/support` command and support button
- Logs blocked attempts to governance audit channel
- Returns clear error message to user

### 2. Draft Expiry (7 days)
- Runs every 5 minutes (piggybacks existing vote check interval)
- Marks proposals as 'expired' if:
  - Status is 'draft'
  - Created more than 7 days ago
  - Support count < threshold (default: 4)
- Disables support button on expired proposal message
- Posts expiration notice to proposals channel
- Logs to governance audit channel

### 3. Governance Audit Logging
Logs these events to dedicated channel (GOVERNANCE_LOG_CHANNEL_ID):
- `proposal_created` - New proposal submitted
- `support_added` - Support added to draft
- `support_blocked` - Self-support attempt blocked
- `proposal_promoted` - Draft promoted to voting
- `vote_cast` - New vote recorded
- `vote_changed` - User changed their vote
- `vote_closed` - Voting ended with result
- `proposal_expired` - Draft expired after 7 days

## Deployment Steps

1. **Update .env file:**
   ```bash
   # Create a new Discord channel for governance logs (recommended: admin-only)
   # Copy the channel ID and add to .env:
   GOVERNANCE_LOG_CHANNEL_ID=123456789012345678
   ```

2. **Pull latest code:**
   ```bash
   cd /path/to/roland-discord-bot
   git pull origin main
   ```

3. **Install dependencies (if any new - none in this case):**
   ```bash
   npm install
   ```

4. **Restart the bot:**
   ```bash
   # If using PM2:
   pm2 restart roland-discord-bot
   
   # If using systemd:
   sudo systemctl restart roland-discord-bot
   
   # If running manually:
   # Stop the bot (Ctrl+C) and restart:
   node index.js
   ```

5. **Verify functionality:**
   - Check bot logs for: "Vote auto-close and draft expiry checker started"
   - Test self-support blocking by creating and trying to support your own proposal
   - Check governance log channel for audit messages
   - (Optional) Test expiry by temporarily modifying the 7-day threshold in code

## Testing Checklist

- [ ] Bot starts without errors
- [ ] Governance log channel receives messages
- [ ] Create proposal → logs "proposal_created"
- [ ] Support proposal (not your own) → logs "support_added"
- [ ] Try to support own proposal → blocked + logs "support_blocked"
- [ ] Proposal reaches 4 supporters → promotes to voting + logs "proposal_promoted"
- [ ] Cast vote → logs "vote_cast"
- [ ] Change vote → logs "vote_changed"
- [ ] Vote closes → logs "vote_closed"
- [ ] (After 7 days) Draft proposals expire if < 4 supporters

## Rollback Plan

If issues arise:
```bash
cd /path/to/roland-discord-bot
git revert 3fe35ca
git push origin main
# Restart bot
```

## Configuration Notes

- **Support threshold**: Configurable in `config/settings.json` (default: 4)
- **Expiry duration**: Hardcoded to 7 days (matches vote duration)
- **Check interval**: 5 minutes (same as vote auto-close checker)
- **Governance log channel**: Optional - if not set, logs are skipped (bot still works)

## API Compatibility

✅ No breaking changes to existing APIs
✅ All existing commands work as before
✅ Database schema unchanged (safe migration)
✅ Backward compatible with existing proposals

## Support

If you encounter issues:
1. Check bot logs for errors
2. Verify GOVERNANCE_LOG_CHANNEL_ID is set correctly
3. Ensure the bot has permissions to post in the governance log channel
4. Check that existing proposals channel permissions are intact

---

**Deployed by:** OpenClaw Subagent  
**Date:** 2026-03-24  
**Commit:** 3fe35ca
