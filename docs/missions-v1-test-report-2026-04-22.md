# Missions v1 Test Report - April 22, 2026

## Local Automated Results
- PASS: `npm run check:missions-smoke`
- PASS: `npm run check:help-parity`
- FAIL (known baseline policy): `npm run check:release-gate`
  - Failing check: `db-adhoc-guard`
  - Message: ad-hoc `db.exec` mutation count in `database/db.js` is above guard baseline.

## Completed Coverage (Automated)
- Spawn mission from template
- Join mission and enforce NFT lock uniqueness
- Resolve mission and award XP/Streetcredit
- Vault redeem stock + balance behavior
- Redemption status updates (`pending/completed/cancelled/failed`)
- Co-op ownership failure handling (`nft_no_longer_owned`)
- Lock cleanup after mission resolution

## Live QA Run Sheet (Discord + Portal)
- [ ] Create template in portal and spawn mission
- [ ] Join via Discord panel and via web flow
- [ ] Verify duplicate lock rejection on second mission
- [ ] Resolve and validate rewards in profile
- [ ] Create manual vault item and redeem once
- [ ] Validate second redeem fails on stock=0
- [ ] Update redemption status from portal
- [ ] Co-op mission: remove one NFT owner before resolve, validate partial fail/success
- [ ] Confirm mission lifecycle posts in configured feed/log channels

## Notes
- Help docs were synchronized to the current command surface:
  - Added governance `comment/cancel/admin panel`
  - Updated Missions commands to `board/profile/join/leave` and admin operations.
