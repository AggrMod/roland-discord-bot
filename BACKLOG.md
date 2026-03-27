
## Voting Power Decoupling (Governance refactor)

**Decision**: Decouple VP from NFT verification tiers.

**Current flow**: Wallet verify → NFT count → Tier → VP
**Target flow**:
- Verification module: Wallet verify → NFT holdings → assigns Discord roles
- Governance module: Discord Role → VP mapping (independent table, admin-configurable)

**Benefits**:
- Give VP to advisors/team/contributors without wallet verify
- Governance works even if verification module is disabled
- Manual role grants still get VP
- Cleaner module separation

**Scope**:
- New DB table: `role_vp_mappings (role_id, voting_power)`
- Admin UI: Governance card gets a "Voting Power Mappings" sub-section
- `proposalService` reads VP from role mappings instead of tier config
- `/verification admin` shows role→VP table separately from tier table
