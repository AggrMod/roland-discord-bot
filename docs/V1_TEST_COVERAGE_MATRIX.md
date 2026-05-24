# V1 Test Coverage Matrix

Last updated: 2026-05-24

Purpose:
- Enforce that every critical bot capability is mapped to one or more automated tests.
- Prevent accidental launch regressions by failing release gate when coverage links are missing.

Source of truth:
- `config/test-coverage-matrix.json`

Validation script:
- `node scripts/check-test-coverage-matrix.js`

Release gate integration:
- Included in `scripts/release-gate.js` as `coverage-matrix`.

How to extend coverage:
1. Add/expand test files in `tests/` or `scripts/`.
2. Add the capability + test file paths in `config/test-coverage-matrix.json`.
3. Run:
   - `npm run check:test-coverage-matrix`
   - `npm test`

Rules:
- Every capability entry must have at least one test path.
- Every listed test path must exist.
- Use stable capability IDs; only rename with deliberate migration.

Current key capability groups:
- Welcome & Onboarding
- Identity & Verification
- Governance & Voting
- Wallet Tracker
- NFT Activity Tracker
- Token Tracker
- Invite Tracker
- AI Assistant
- Support Tickets
- Engagement
- Minigames
- Missions
- Vault
- Self-Serve Roles
- Moderation
- Config Command
- Superadmin Workspace
