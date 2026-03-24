# Deploy Notes: Collection Resolver (Slug + Address Support)

**Commit:** 0fb9c5d  
**Date:** 2026-03-24  
**Status:** ✅ Ready to Deploy

## Summary

Enhanced `/verification actions addcollection` to accept **both** collection slugs and Solana mint addresses, with automatic type detection and normalization.

## What Changed

### New Files
- **`utils/collectionResolver.js`**: Core resolver utility
  - `resolveCollectionInput()`: Auto-detects slug vs address
  - `formatCollectionForDisplay()`: Unified display formatting with type icons
  - Solana address validation (base58, 32-44 chars)

### Modified Files
- **`commands/admin/verification.js`**:
  - Updated `handleAddCollection()` to use resolver
  - Updated `handleRemove()` to support both formats
  - Updated `handleActionsList()` to show type indicators (📦 slug, 🔑 address)
  - Updated help text: "Collection slug (e.g., "solpranos-main") or mint address"

- **`services/roleService.js`**:
  - `addCollection()` now accepts `type` and `originalInput` parameters
  - `getCollectionsSummary()` returns type metadata
  - Collections stored with normalized keys (`slug` or `addr:...`)

### Test Coverage
- **`test-collection-resolver.js`**: Sanity checks (✅ all pass)
  - Slug normalization (lowercase, hyphenated)
  - Address detection and formatting
  - Invalid input rejection
  - Display formatting

## How It Works

### Input Resolution
| Input Type | Example | Stored Key | Type |
|-----------|---------|-----------|------|
| Slug | `solpranos-main` | `solpranos-main` | `slug` |
| Mixed Case Slug | `SolProNos Main` | `solpronos-main` | `slug` |
| Solana Address | `7xKXtg2CW87d97...` | `addr:7xKXtg2CW87d97...` | `address` |

### Display Format
- **Slug**: `📦 Collection Name → @Role`
- **Address**: `🔑 7xKXtg2C...JosgAsU → @Role`
- **Token** (legacy): `💰 Token Name → @Role`

## Backward Compatibility

✅ **No Breaking Changes**
- Existing collections continue to work
- Command signature unchanged
- Legacy token format (`token:...`) still supported
- Remove flow handles both old and new formats

## Deploy Steps

### Required: Command Redeploy
```bash
node deploy-commands.js
```

**Why?** Updated help text for the `collection` option requires Discord command metadata refresh.

### Verification After Deploy
1. Test slug input: `/verification actions addcollection role:@Test collection:test-collection`
2. Test address input: `/verification actions addcollection role:@Test collection:7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU`
3. Check list: `/verification actions list` (should show type icons)
4. Test remove: `/verification actions remove role:@Test type:collection identifier:test-collection`

## Future Enhancements (Optional)

- On-chain validation: Query Metaplex to verify collection exists
- Collection lookup: Fetch collection name from on-chain metadata
- Duplicate detection: Warn if slug and address refer to same collection
- Migration tool: Convert existing slugs to addresses (if needed)

## Notes

- Addresses must be valid base58 (32-44 chars)
- Slugs normalized to lowercase, spaces → hyphens
- Both formats work for add/remove operations
- Original input preserved in config for reference
