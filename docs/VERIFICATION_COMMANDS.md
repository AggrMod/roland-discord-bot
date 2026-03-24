# Verification Commands Guide

## Overview

The `/verification` command suite provides an intuitive interface for managing the Solpranos Family verification system. This guide covers all commands with examples and best practices.

## Quick Start

### Post a Verification Panel

```
/verification create
```

This posts a verification panel to the current channel with default Solpranos styling.

### Customize the Panel

```
/verification create title:"Join the Family" description:"Verify your wallet to access exclusive roles" color:#8B0000 footer_text:"The Solpranos - Est. 2024"
```

**Customization Options:**
- `title` - Panel heading (default: "🔗 Verify your wallet!")
- `description` - Panel message
- `color` - Hex color code (default: #FFD700 - gold)
- `footer_text` - Footer message (default: "Solpranos")
- `thumbnail` - Thumbnail image URL (default: bot avatar)
- `image` - Large banner image URL

---

## Managing Verification Actions

### View All Actions

```
/verification actions list
```

Shows all configured verification actions including:
- **Collections** - NFT collection holders
- **Tier Roles** - Roles based on NFT count (Associate, Soldato, Capo, etc.)
- **Trait Roles** - Roles based on NFT traits (e.g., "The Hitman")

---

## Adding Verification Actions

### Collection-Based Roles

Assign a role when members hold NFTs from a specific collection:

```
/verification actions addcollection role:@Holder collection:solpranos-main
```

**Require multiple NFTs:**
```
/verification actions addcollection role:@Whale collection:solpranos-main amount:10
```

**Trait-filtered collection:**
```
/verification actions addcollection role:@Hitman collection:solpranos-main traitname:Role traitvalue:The Hitman
```

This assigns the `@Hitman` role to members who hold NFTs from `solpranos-main` with the trait "Role: The Hitman".

---

### Token-Based Roles

Assign a role when members hold SPL tokens:

```
/verification actions addtoken role:@TokenHolder token:$BRUNO amount:1000
```

This assigns `@TokenHolder` to anyone holding at least 1,000 $BRUNO tokens.

---

## Removing Verification Actions

Remove an action by specifying the role and action type:

```
/verification actions remove role:@Holder type:collection identifier:solpranos-main
```

**For traits:**
```
/verification actions remove role:@Hitman type:trait identifier:Role:The Hitman
```

**For tokens:**
```
/verification actions remove role:@TokenHolder type:token identifier:$BRUNO
```

💡 **Tip:** If only one action exists for a role, you can omit the identifier:
```
/verification actions remove role:@UniqueRole type:collection
```

---

## Member Management

### Export Member Data

View a member's verification status, wallets, and NFT holdings:

```
/verification exportuser user:@username
```

**Output includes:**
- NFT Holdings
- Current Rank (Associate, Soldato, etc.)
- Voting Power
- Linked Wallets (with primary wallet indicator ⭐)
- Member Since date

---

### Remove Member

Permanently remove a member from the verification system:

```
/verification removeuser user:@username confirm:true
```

⚠️ **Warning:** This action:
- Deletes all linked wallets
- Removes all Family roles
- Erases verification data
- **Cannot be undone**

Must set `confirm:true` to execute.

---

## Common Workflows

### Setting Up Basic Verification

1. **Configure tier roles** (if not already done):
   ```
   /role-config add-tier name:Associate min_nfts:1 max_nfts:2 voting_power:1 role:@Associate
   ```

2. **Add collection role**:
   ```
   /verification actions addcollection role:@Holder collection:solpranos-main
   ```

3. **Post verification panel**:
   ```
   /verification create
   ```

---

### Setting Up Trait-Based Roles

1. **Create Discord roles** for each character trait

2. **Add trait mappings**:
   ```
   /verification actions addcollection role:@Hitman collection:solpranos-main traitname:Role traitvalue:The Hitman
   /verification actions addcollection role:@Accountant collection:solpranos-main traitname:Role traitvalue:The Accountant
   /verification actions addcollection role:@Driver collection:solpranos-main traitname:Role traitvalue:The Driver
   ```

3. **Verify** members start receiving trait roles automatically after verification

---

### Token Holder Perks

Reward members who hold your community token:

```
/verification actions addtoken role:@Diamond-Hands token:$BRUNO amount:50000
/verification actions addtoken role:@Whale token:$BRUNO amount:500000
```

---

## Advanced: Role-Config Commands

For power users who need granular control over tier mechanics and voting power:

```
/role-config list
/role-config add-tier name:Custom min_nfts:20 max_nfts:49 voting_power:8 role:@Custom
/role-config edit-tier name:Associate voting_power:2
/role-config sync user:@username
```

💡 **When to use `/role-config`:**
- Adjusting NFT tier thresholds
- Modifying voting power values
- Force re-syncing roles after manual changes
- Direct trait-to-role mapping (without collection context)

💡 **When to use `/verification actions`:**
- Day-to-day management
- Adding new collections or tokens
- Removing outdated actions
- All standard admin tasks

---

## Validation & Error Messages

The system provides clear feedback for common issues:

❌ **Invalid collection ID** - Must be at least 3 characters
❌ **Missing trait pairing** - Both traitname and traitvalue must be provided together
❌ **Invalid amount** - Must be greater than 0
❌ **Invalid color** - Use hex format (e.g., #FFD700)
❌ **Action not found** - Check the identifier or use `/verification actions list`
❌ **Member not verified** - User has no linked wallets yet

---

## Backward Compatibility

All existing configurations, stored actions, and role mappings remain intact. The new command structure is a UX enhancement that works with the same underlying data.

**Migration Notes:**
- Old collection IDs and trait mappings are preserved
- Role IDs remain unchanged
- Tier thresholds and voting power are not affected
- No database migration required

---

## Examples: Complete Setup

### Basic Setup (Collection + Tiers)

```bash
# 1. Create tier roles (one-time setup)
/role-config add-tier name:Associate min_nfts:1 max_nfts:2 voting_power:1 role:@Associate
/role-config add-tier name:Soldato min_nfts:3 max_nfts:6 voting_power:3 role:@Soldato

# 2. Add collection verification
/verification actions addcollection role:@Verified collection:solpranos-main

# 3. Post panel
/verification create title:"Verify and Join the Family" color:#8B0000
```

### Advanced Setup (Traits + Tokens)

```bash
# 1. Character trait roles
/verification actions addcollection role:@Hitman collection:solpranos-main traitname:Role traitvalue:The Hitman
/verification actions addcollection role:@Consigliere collection:solpranos-main traitname:Role traitvalue:The Consigliere

# 2. Token holder roles
/verification actions addtoken role:@Staker token:$BRUNO amount:10000

# 3. Custom panel
/verification create title:"🔫 Family Verification" description:"Verify your wallet to access character roles and token perks" color:#DC143C image:https://example.com/banner.png
```

---

## Tips & Best Practices

✅ **Use friendly names** - Collection identifiers should be memorable (e.g., "solpranos-main" not "ABC123XYZ")

✅ **Test with exportuser** - After setup, verify a test account and check with `/verification exportuser`

✅ **Sync after changes** - Use `/role-config sync` to force role updates after modifying tier thresholds

✅ **Keep advanced configs separate** - Use `/role-config` for tier mechanics, `/verification` for actions

✅ **Document your setup** - Keep a list of your collection IDs and trait mappings for reference

---

## Support

For questions or issues:
1. Check `/verification actions list` to see current configuration
2. Use `/verification exportuser` to debug individual member issues
3. Review logs for detailed error messages
4. Consult the advanced guide for `/role-config` power features

---

**Last Updated:** Phase 1 Verification UX Pass
**Related Docs:** `/docs/architecture.md`, `README.md`
