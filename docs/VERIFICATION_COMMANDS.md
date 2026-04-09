# Verification Command Guide

This guide reflects the current live `/verification` command surface.

## User Commands
- `/verification status` - Show verification status, tier, voting power, and holdings summary.
- `/verification wallets` - List linked wallets.
- `/verification refresh` - Recalculate holdings and refresh roles.
- `/verification quick` - Run micro-transfer quick verification.

## Admin Commands
- `/verification admin panel` - Post a verification panel in-channel.
- `/verification admin export-user` - Export one member's verification data.
- `/verification admin remove-user` - Remove a member's verification record (requires confirm).
- `/verification admin export-wallets` - Export verified wallets CSV (optional `role` and `primary-only`).
- `/verification admin token-role-add` - Add token balance role rule.
- `/verification admin token-role-remove` - Remove token balance role rule by ID.
- `/verification admin token-role-list` - List token balance role rules.
- `/verification admin role-config` - Manage collection/trait role mapping actions.
- `/verification admin actions` - Show verification actions overview.
- `/verification admin og-view` - View OG role configuration.
- `/verification admin og-enable` - Enable/disable OG role system.
- `/verification admin og-role` - Set OG role.
- `/verification admin og-limit` - Set OG slot count.
- `/verification admin og-sync` - Sync OG role assignments.

## Common Examples

### Post a panel
```bash
/verification admin panel title:"Verify your wallet" description:"Connect and verify to unlock roles" color:#FFD700
```

### Add a token role rule
```bash
/verification admin token-role-add mint:So11111111111111111111111111111111111111112 role:@Holder min_amount:1 symbol:SOL
```

### Export only primary wallets for a role
```bash
/verification admin export-wallets role:@Verified primary-only:true
```

### Refresh and check status
```bash
/verification refresh
/verification status
```

## Notes
- Verification identity is global per user profile; tenant role/output behavior is tenant-configured.
- Module entitlements are enforced per tenant plan.
- For panel/channel management in bulk, use the web portal (`/admin` -> Verification).
