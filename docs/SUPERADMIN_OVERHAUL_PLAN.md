# Implementation Plan: Superadmin Settings Overhaul and Subscription Manager

This plan defines a refactor of the Superadmin Portal for a cleaner experience, better tenant controls, and payment-backed subscription workflows.

---

## 1. Core Objectives

1. **Modernized UI**: Replace cluttered interfaces with a standardized dashboard style aligned to the main portal.
2. **Crypto Payment System**: Support automatic and manual validation of SOL/USDC subscription payments into a global vault wallet.
3. **Robust Expirations and Limits**: Let Superadmins assign plans directly, configure explicit expiration dates, and manage module entitlements safely.

---

## 2. Database Schema Upgrades

### Table: `crypto_payment_receipts`

```sql
CREATE TABLE IF NOT EXISTS crypto_payment_receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  tx_signature TEXT UNIQUE NOT NULL,
  amount REAL NOT NULL,
  token_symbol TEXT NOT NULL,
  sender_wallet TEXT NOT NULL,
  plan_key TEXT NOT NULL,
  billing_interval TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  verification_error TEXT DEFAULT NULL,
  verified_at DATETIME DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

---

## 3. Superadmin Portal Redesign

### Dashboard Surface
- System metrics
- Tenant grid
- Payments ledger
- Audit stream

### Tenant Management Features
- Plan selector (`starter`, `pro`, `enterprise`)
- Explicit expiration date picker
- Module override switchboard (enable/disable per tenant regardless of base plan)

---

## 4. Crypto Payment Verification Engine

Create `services/cryptoPaymentService.js`.

### Flow
1. User submits transaction signature in Billing UI.
2. Backend verifies on-chain transaction using `@solana/web3.js` (`getParsedTransaction`).
3. Validation checks:
   - Transaction succeeded
   - Recipient equals configured global vault wallet
   - Amount matches selected plan and interval
   - Transaction timestamp is recent (prevents replay)
4. If valid:
   - Mark receipt `verified`
   - Update `tenant_billing` (`subscription_status`, `last_payment_at`, `current_period_end`)
   - Apply plan with `tenantService.setTenantPlan(guildId, planKey)`
5. If invalid:
   - Mark receipt `failed`
   - Store error reason for review

---

## 5. Implementation Milestones

### Phase 1: Data Layer
- Add `crypto_payment_receipts`
- Add indexes for fast `guild_id` and `tx_signature` lookup

### Phase 2: Superadmin API
Add routes in `routes/superadminTenantOps.js`:
- `GET /api/superadmin/payments`
- `POST /api/superadmin/payments/manual-approve`
- `POST /api/superadmin/tenants/:guildId/plan-override`

### Phase 3: Portal UX
- Refactor `portal.html`, `portal.js`, `portal-style.css`
- Add search/filter controls
- Add tenant manage modal
- Add payment verification status views

---

## 6. Verification and Test Plan

### Automated
Create `tests/test-crypto-payments.js` with cases for:
- Valid USDC/SOL transfer -> plan activation
- Wrong recipient or stale signature -> rejection
- Signature reuse attempt -> unique-constraint rejection

### Manual QA
- Override tenant plan and expiration as Superadmin
- Validate module access changes at expiry boundaries
- Confirm manual restore and override workflows
