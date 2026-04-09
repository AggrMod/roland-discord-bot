# Pilot Onboarding SOP

Use this sequence for a new pilot server.

## Steps

1. Invite the bot to the server.
2. Select the target server in the admin portal.
3. Set branding for the tenant.
4. Assign the pilot plan.
5. Enable the required modules.
6. Test verification, ticketing, and governance flows.

## Expected outcomes

- The bot appears online in the server.
- Branding is reflected in the portal and bot surfaces.
- The assigned plan updates enabled modules and plan limits.
- Verification commands resolve and role grants work.
- Ticket creation opens the configured ticket flow.
- Governance commands can create, review, and conclude proposals.

## Rollback notes

- If the pilot needs to be reversed, set the tenant status back to `suspended` or reassign the previous plan.
- Confirm module settings after rollback because plan changes can alter defaults.
- If the bot misbehaves, check the latest backup before restoring the database.
- After any rollback, run the health check and validate the tenant record in the portal.
