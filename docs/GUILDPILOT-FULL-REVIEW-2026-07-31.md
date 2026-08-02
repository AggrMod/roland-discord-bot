# GuildPilot full technical, security, EVM and UI/UX review

**Review date:** 2026-07-31

**Scope:** tracked source code, server and Discord bot architecture, database schema and migrations, wallet verification, webhook ingestion, dependencies, automated checks, landing page and portal UI.

**Important limitation:** this was a source-assisted engineering review, not an external penetration test or production infrastructure audit. No production secrets, cloud configuration, live database or deployed network boundary was tested.

## Implementation status after remediation

The implementation pass is complete for the requested sequence: security/reliability fixes, premium portal and AI Assistant simplification, then the first production-oriented EVM layer.

- The three original P0 paths are remediated: unsafe portal interpolation was removed, CSP was re-enabled in compatibility mode, AI imports now use a bounded SSRF-resistant fetcher, and production vault webhooks enforce per-guild binding.
- One-time wallet challenges are bound to session, stable Discord identity, guild, origin, exact address, chain and expiry. OAuth state/session handling, CSRF, encrypted OAuth credentials, encrypted backups and durable webhook acceptance were hardened.
- Production dependency exposure is now **3 moderate, 0 high and 0 critical**. The remaining advisories are isolated to the Solana `@solana/web3.js` / `jayson` / `uuid` graph; npm's suggested fix is an invalid legacy downgrade.
- The portal now uses the premium information hierarchy, with the AI Assistant reduced to Setup, Knowledge, Channel behavior and Advanced workspaces.
- EVM support now includes chain-aware identities; EIP-4361-style EOA signing; Ethereum, Base, Polygon, Arbitrum and Optimism; native/ERC-20 holdings; ERC-20 transfer tracking; ERC-721 mint/transfer tracking; native wallet transaction alerts; confirmation-aware cursors; and chain-specific explorer links.

Remaining release caveats: CSP still permits inline compatibility and should be made strict after portal modularization; ERC-1271 contract-wallet signatures and ERC-1155 live event polling are follow-ups; each production RPC endpoint still needs a live provider/rate-limit smoke test. The detailed findings below preserve the original review state and evidence, while this section records what was changed afterward.

## Executive verdict (original review state)

GuildPilot has a broad, commercially useful feature set and several good foundations: prepared SQL is used consistently, tenant access is generally rechecked against Discord, sensitive comparisons use timing-safe checks, rate limits and webhook batch limits exist, mock token paths have production guards, and the most relevant targeted security tests passed.

It is **not ready for an unrestricted public multi-tenant launch** yet. Three findings should block that launch:

1. The admin portal contains a stored-XSS path while Content Security Policy is disabled.
2. AI knowledge imports can make arbitrary outbound HTTP requests and read unbounded responses, creating SSRF and denial-of-service exposure.
3. Vault webhook guild binding is still disabled by default, so a legacy global secret can preserve a cross-tenant acceptance path.

EVM support should not be added by copying the Solana implementation. The current data model assumes one address format, one chain, floating-point amounts, Solana signatures and Helius-shaped events. The correct preparation is a chain-neutral identity and event layer, followed by EVM adapters. Doing this first will make wallet verification, token/NFT gating and trackers safer and considerably easier to maintain.

The public landing page already has a convincing premium visual direction. The product portal does not yet match it: it is a 1.2 MB JavaScript monolith with a very dense DOM, extensive inline behavior and styles, weak form labelling, and a mobile loading experience that loses the brand and navigation. Premium here should mean calmer information architecture, stronger trust signals, predictable states and fewer controls on screen—not additional decoration.

## Priority register

| Priority | Finding | Risk | Recommended release treatment |
|---|---|---|---|
| P0 | Stored XSS in admin dashboard plus CSP disabled | Admin/superadmin session compromise and cross-tenant actions | Fix before public launch |
| P0 | AI URL/PDF import SSRF and unbounded downloads | Internal service access, cloud metadata exposure, memory exhaustion | Fix before public launch |
| P0 | Vault webhook tenant binding defaults to `off` | Cross-guild event injection when legacy secret is accepted | Change to enforced and migrate secrets before launch |
| P1 | Wallet challenges are not bound to wallet, Discord user, guild, domain, chain or expiry | Replay/account-confusion risk; unsafe basis for EVM | Replace before expanding verification |
| P1 | OAuth state is not session-bound/one-time and session is not regenerated after login | Login CSRF/account confusion and session-fixation hardening gap | Fix before launch |
| P1 | 12 production dependency advisories (2 high, 10 moderate) | Known issues in HTTP/WebSocket/Discord stack | Upgrade and retest before launch |
| P1 | SQLite sessions contain plaintext Discord access/refresh tokens | Database/backup leak becomes Discord token leak | Encrypt/separate and minimize scopes |
| P1 | Solana addresses are lowercased in several flows | False identity equality and incorrect matching | Introduce chain-specific canonicalization |
| P1 | Token values use SQLite `REAL` and JavaScript `Number` | Incorrect EVM `uint256` balances and thresholds | Store raw decimal integers and use `BigInt` |
| P1 | Webhooks can return 200 before an event is durably queued | Silent event loss on crash/restart | Persist first, acknowledge second |
| P2 | CSRF endpoint returns an empty token | Defense depends on SameSite, CORS and a custom header | Add real tokens plus Origin checking |
| P2 | Unencrypted local backups and coupled encryption keys | PII/secret exposure and difficult key rotation | Encrypt backups; use a versioned dedicated key |
| P2 | Giant single-process modules and fail-open entitlement guards | Operational fragility and difficult safe change | Split boundaries; fail closed for protected features |
| P2 | Debug/data artifacts and database files in a synced working folder | Accidental privacy/data disclosure | Clean tracked diagnostics and tighten data handling |

## Security findings

### 1. P0 — stored XSS in an administrator context

The dashboard builds HTML with server-controlled values. `server.name`, `server.icon` and an error value are interpolated into `innerHTML` without contextual escaping. Guild names originate from Discord and cannot be treated as trusted HTML. CSP is explicitly disabled because the portal relies on inline scripts, event handlers and styles.

**Impact:** a crafted guild name or other stored/displayed value could execute JavaScript in an administrator or superadministrator browser. With no CSP containment, this can call same-origin APIs using the victim's authenticated session.

**Remediation:**

- Immediately replace these interpolations with `textContent`, safe attribute assignment and validated URLs.
- Inventory all `innerHTML` assignments; escaping only one card is not sufficient.
- Remove inline event handlers and inline scripts, ship nonce/hash-compatible bundles, enable CSP in report-only mode, then enforce it.
- Add a regression test using payloads in guild names, messages, contract names, ENS names, NFT metadata and API errors.

Evidence: `web/public/portal.js` around lines 22579 and 22597–22604; `web/routes/adminCore.js` around lines 316–320; `web/server.js` around lines 297–301.

### 2. P0 — SSRF and unbounded AI imports

The AI knowledge URL and PDF import accepts `http`/`https`, follows redirects, and does not reject loopback, link-local, private, metadata-service or internal DNS targets. HTML is read completely before truncation; PDFs are loaded completely into memory before parsing. There is no reliable redirect-hop revalidation, MIME allowlist or streaming byte ceiling.

**Impact:** a tenant administrator could probe internal services or cloud metadata endpoints, and a large response can consume substantial memory or CPU.

**Remediation:** create one hardened outbound-fetch service that resolves and validates every redirect hop, blocks private/local IPv4 and IPv6 ranges, limits ports and redirects, enforces DNS/IP consistency, validates MIME, streams to a strict byte cap and uses an egress firewall. Treat parser work as a constrained background job.

Evidence: `services/aiAssistantService.js` around lines 152–163, 273–280, 1027–1055 and 1117–1145.

### 3. P0 — vault webhook guild binding is fail-open by default

`VAULT_WEBHOOK_ENFORCE_GUILD_MATCH` defaults to `off`. Off/monitor modes still accept the legacy global-secret chain and use a caller-supplied guild ID; monitor mode logs mismatches but accepts them.

**Impact:** the prior cross-tenant webhook problem is only truly closed in deployments that explicitly set enforce mode and use per-guild secrets.

**Remediation:** make enforcement the only production behavior, remove the global fallback after a measured migration period, store tenant secrets in a KMS-backed/versioned store, and alert on every rejected mismatch. Add a startup failure if production is configured with legacy/off mode.

Evidence: `web/routes/vaultWebhooks.js` around lines 18–35 and 68–142.

### 4. P1 — wallet verification challenge is under-bound

The current message contains a brand string, mutable Discord username and nonce. It does not commit to the submitted wallet address, Discord ID, guild ID, requesting domain/URI, chain, purpose, issue time or expiry. Verification then checks the separately submitted address. There are two overlapping verification endpoints, and failed attempts do not follow one uniform atomic-consumption path.

**Remediation:** store hashed, high-entropy challenges server-side with a five-minute expiry and atomically consume on use. The signed message must include the exact wallet, stable Discord ID, guild, origin, chain/chain ID, purpose, issued time, expiry and request ID. Rate-limit by session, Discord ID, wallet and IP. Use SIWE for EVM and an equivalently structured Sign-In With Solana message for Solana.

Evidence: `web/routes/userWalletVerification.js` around lines 53–61, 73–90 and 141–153; `web/server.js` around lines 1610–1617.

### 5. P1 — OAuth/session hardening gaps

- The OAuth `state` value is signed, but its nonce is not stored and atomically consumed against the initiating browser session.
- The session is not regenerated before the authenticated Discord identity and OAuth tokens are assigned.
- Persistent SQLite session records contain Discord access and refresh tokens in plaintext.
- Logout clears the cookie without mirroring every configured cookie attribute.
- Superadmin authorization relies on a Discord ID in a normal session with no recent-auth/step-up requirement.

**Remediation:** bind state to the initiating session, store only a hash, enforce a short expiry and one-time use; regenerate the session on privilege transition; move OAuth credentials to a separately encrypted token vault; mirror cookie attributes on logout; require recent authentication and preferably WebAuthn/TOTP for superadmin actions.

Evidence: `web/routes/authUser.js` around lines 1195–1202, 1274–1286 and 1302–1305; `web/server.js` around lines 329–362 and 484–520; `middleware/superadminGuard.js`.

### 6. P1 — known dependency vulnerabilities

`npm audit --omit=dev` reported **12 production advisories: 2 high and 10 moderate**. The affected graph includes `undici`, `ws`, Express/body-parser/`qs`, `express-rate-limit`/`ip-address`, Discord REST dependencies, and the Solana RPC graph.

The dry run indicates non-breaking updates are available for most of the graph, including Discord.js, `undici`, `ws`, Express, `express-rate-limit`, `qs`, body-parser, `uuid` and `ip-address`. The audit recommendation for `@solana/web3.js` proposes an invalid legacy downgrade and must not be applied blindly.

**Remediation:** update the lockfile intentionally, run the full release suite and a Discord/RPC smoke test, and document the remaining Solana advisory exception with compensating controls and an upgrade owner.

### 7. P1 — chain identity and numeric correctness

Some wallet paths lower-case addresses and several queries compare them with `LOWER(...)`. That convention is useful for EVM lookup but incorrect for case-sensitive Solana base58 addresses. The wallet table has one raw globally unique address with no chain namespace. Token and tracker amounts use SQLite `REAL` and JavaScript `Number`, which cannot represent EVM `uint256` values safely.

**Remediation:** make address canonicalization an explicit chain-adapter function. Preserve checksummed EVM display addresses, use lowercase bytes/hex for EVM lookup, and preserve Solana case exactly. Store asset amounts as raw base-unit decimal text (or fixed bytes) plus decimals; use `BigInt` internally and format only at the UI boundary.

Evidence: `services/walletService.js` around lines 7–9; `database/db.js` wallet schema around lines 354–363 and amount fields around 1724–1727; token/tracker services.

### 8. P1/P2 — webhook durability and data protection

Activity endpoints schedule ingestion with `setImmediate` and can return HTTP 200 before durable persistence. A process restart in that window loses an event while the sender believes it was accepted.

Database backups are plain file copies retained locally. The workspace is itself in a OneDrive-synced directory and currently contains untracked SQLite databases and an exported wallet-transfer CSV. Tracked diagnostics include wallet/transaction investigation scripts and `sigs.json`, which increase accidental privacy exposure. The secret vault derives from `SUPERADMIN_SECRET_KEY || SESSION_SECRET`, coupling two security domains and offering no key ID/rotation mechanism.

**Remediation:** insert an idempotent inbox job transactionally before returning 2xx; encrypt backups with a dedicated versioned key; restrict file permissions and retention; test restores; separate session, data and webhook keys; remove or sanitize tracked investigation artifacts and expand repository/data-handling policy.

Evidence: `web/routes/activityWebhooks.js` around lines 49–100; `services/databaseBackupService.js` around lines 18–58 and 127–154; `utils/secretVault.js` around lines 6–9.

### 9. P2 — CSRF protection is incomplete

SameSite cookies, CORS and the required `X-Requested-With` marker provide useful cross-site-form protection. However, the `/api/csrf-token` endpoint returns an empty token and the installed CSRF package is unused. This is not robust token-based CSRF protection and becomes especially weak if an allowed origin or same-origin script is compromised.

**Remediation:** issue a real per-session token, validate it on mutations, validate `Origin`/`Referer` against a strict allowlist, and retain the custom-header requirement as defense in depth.

Evidence: `web/server.js` around lines 364–386.

## Positive security controls observed

- Prepared statements dominate database access; no clear SQL injection path was found in the reviewed code.
- Admin access is generally tenant-scoped and revalidated against live Discord guild membership/permissions.
- Timing-safe comparisons are used for webhook secrets.
- Webhook body/batch limits and rate limits exist.
- Billing/idempotency logic has durable safeguards in several money-related paths.
- Production mock-token guards now exist.
- Wallet delegation endpoints are explicitly disabled rather than accepting an insecure proof.
- Targeted webhook, tenant-scoping and portal-script safety checks passed.

These are useful controls, but they do not offset the P0 findings above.

## Inactive code and maintainability review

### Confirmed or strongly indicated inactive/duplicated surfaces

- Static production entrypoint tracing found `middleware/moduleGate.js` and `utils/interactionEphemeralCompat.js` unreachable. There are at least three module/plan-gating implementations: the inline gate in `index.js`, `middleware/moduleGate.js` and `utils/moduleGuard.js`.
- Wallet delegation is deliberately disabled, but its tables, migration/audit support and revoke surfaces remain. Keep it behind an explicit feature record/ADR or remove the dormant surface until a cryptographic design exists.
- `web/public/admin.html` is a legacy parallel admin page served only at `/admin-panel`; decide and publish its retirement date.
- Root-level `debug_*`, `scratch_query.js` and `sigs.json` are operational investigation artifacts rather than product code. Move reusable tooling under a guarded `tools/` package and purge real identifiers.
- `index.js` contains unused constants/cache variables and unused imports. Portal lint warnings are inflated because inline HTML handlers hide references, which itself is a reason to move to modules.

### Structural debt

- `index.js` is about 1,600 lines; `web/server.js` about 1,500; `database/db.js` about 1,945; `trackedWalletsService.js` about 2,600.
- `web/public/portal.js` is roughly **1.2 MB / 21k+ lines** and the CSS roughly **166 KB / 6.6k lines**.
- Boot-time schema creation, structured migrations and file migrations overlap in one database module, with many swallowed migration errors.
- The bot, API, timers, in-memory caches and asynchronous webhook work run in one process against SQLite.
- Several plan/module guards catch errors and allow access. Billing/entitlement failures should fail closed for protected features.

### Recommended target boundaries

1. `apps/bot`, `apps/api`, `apps/worker` as separate runtime entrypoints.
2. Domain packages for identity, authorization, billing, activity, governance and AI.
3. `chains/core`, `chains/solana`, `chains/evm` behind one tested interface.
4. Repository classes and explicit migrations outside the database bootstrap.
5. A durable job/inbox table immediately, then a proper queue when running multiple processes.
6. Central configuration validation at startup; no silent production defaults for security-sensitive modes.
7. Typed error categories, structured logs, metrics and trace/request IDs instead of empty catches.

## EVM readiness blueprint

### Standards and product scope

Use [ERC-4361 Sign-In with Ethereum](https://eips.ethereum.org/EIPS/eip-4361) for human-readable, origin-bound wallet verification. Support contract wallets and multisigs through [ERC-1271](https://eips.ethereum.org/EIPS/eip-1271), not EOA recovery alone. Asset support should cover [ERC-20](https://eips.ethereum.org/EIPS/eip-20), [ERC-721](https://eips.ethereum.org/EIPS/eip-721) and [ERC-1155](https://eips.ethereum.org/EIPS/eip-1155).

Recommended first networks: **Base and Ethereum**, then Arbitrum, Optimism and Polygon based on customer demand. Keep the registry configuration-driven; do not scatter chain-ID conditionals through features.

### Chain adapter contract

Every chain implementation should provide the same capabilities:

```text
validateAddress / canonicalizeAddress / displayAddress
createOwnershipChallenge / verifyOwnershipProof
getNativeBalance / getFungibleBalances / getNftOwnership
getTransactions / getTransfers / subscribeToEvents
getFinalityStatus / explorerUrl
verifyWebhook / normalizeEvent
```

The EVM adapter should use a maintained typed client with native `BigInt` semantics (for example viem), separate read clients per network/provider, timeouts, retry budgets, circuit breakers and provider-health metrics. Avoid letting provider-specific webhook payloads escape the adapter.

### Proposed data model

- `wallet_accounts`: Discord user, chain family, canonical address, display address, verification method/timestamps and revocation state.
- `wallet_account_networks`: account-to-chain-ID activation and last observed block.
- `wallet_challenges`: hashed nonce/message, Discord ID, guild ID, address, chain, origin, purpose, expiry and atomic consumption time.
- `asset_contracts`: chain ID, contract, standard, symbol, decimals and metadata source.
- `asset_role_rules`: guild, asset, optional token ID, comparison operator and raw threshold text.
- `tracked_accounts` and `tracked_assets`: guild-scoped subscriptions with confirmation policy.
- `chain_events`: chain, transaction hash, block number/hash, log/trace index, normalized type, addresses, raw amount text, metadata and status (`observed`, `confirmed`, `orphaned`).
- `event_deliveries`: idempotent Discord delivery state, retries and dead-letter reason.

Use unique keys such as `(chain_id, tx_hash, log_index, sub_index)` and retain the block hash. Migrate existing wallets/rules/events as `solana:mainnet`, dual-read during backfill, then make namespace fields mandatory. Do not mutate the existing table in one irreversible deployment.

### Wallet verification flow

1. User selects a network and connects a wallet through an injected provider or WalletConnect-compatible connector.
2. Server creates a one-time challenge bound to origin, stable Discord ID, guild, exact address, chain ID and purpose.
3. Wallet signs the complete SIWE message.
4. Server validates syntax and every expected field, then verifies an EOA signature or calls ERC-1271 on the specified chain for a contract account.
5. In one transaction, consume the challenge, upsert the verified wallet and enqueue role evaluation.
6. UI shows the checksummed/ENS display identity, chain badge, verification time and a clear revoke action.

Wallet connection must remain read-only: GuildPilot never needs a seed phrase, private key, token approval or transaction-signing permission for ownership verification.

### NFT and token gating

- ERC-20 rules compare a raw integer balance against a decimal-aware threshold.
- ERC-721 rules support collection ownership and optional token-ID ownership.
- ERC-1155 rules require both contract and token ID, with a raw quantity threshold.
- Re-evaluate roles on normalized transfer events and by periodic reconciliation; webhooks alone are not authoritative.
- Cache metadata separately from balances. Treat names, symbols, images, token URIs and ENS data as untrusted content.
- Record the block/finality used for every decision so support staff can explain role changes.

### Trackers

**Wallet tracker:** native transactions, token transfers and NFT movements. Native/internal EVM transfers may require traces or an indexer; logs alone are incomplete.

**Token tracker:** ERC-20 `Transfer` events, mint/burn labelling, configurable minimums and confirmed delivery.

**NFT tracker:** ERC-721 transfers and ERC-1155 `TransferSingle`/`TransferBatch`, with collection metadata and spam filtering.

**Trade/sale tracker:** a separate later capability. A transfer is not inherently a buy/sell; reliable classification needs marketplace/DEX decoding and quote-value attribution.

All trackers must handle reorgs: ingest as observed, retain block hash, wait for a per-chain confirmation policy, mark orphaned events on rollback, and make Discord delivery idempotent. Persist the event before acknowledging a provider webhook.

## Premium UI/UX review

### Current state

The landing page has the strongest product quality: dark navy/purple art direction, good typography, clear hierarchy and a convincing product mock. It has one H1, a useful meta description, complete image alt text and no horizontal overflow in the tested desktop/mobile widths.

Problems that reduce trust:

- “View Demo” and “Join Demo Server” currently point to `#`.
- “Solana-native” messaging conflicts with the intended multi-chain product direction.
- At 390 px, the brand and Login control visually collide (`GuildPilotLogin`).
- The mobile hero is long and defers meaningful product proof below the first screen.
- The landing page lacks the portal's reduced-motion/focus-visible treatment.

The portal uses the right palette but feels like an internal configuration console. In the inspected static state it contains roughly 3,075 DOM nodes, 206 form fields, **135 fields without an associated label**, 198 buttons, 235 inline event handlers and 512 inline-style elements. The stylesheet contains about 269 `!important` declarations. When APIs are unavailable, the portal can remain indefinitely on “Configuring your workspace...” with no useful recovery path. On mobile that state loses visible brand/navigation context.

### Product experience direction

Use a **command center** model:

- Overview: verification rate, protected members, tracker health, recent role changes and failed actions.
- Setup: a persistent checklist—connect Discord, select chains, configure verification, add role rules, add tracker, send test, launch.
- Members: searchable wallet identities and role decisions with an evidence drawer.
- Assets: contracts/collections, validation status and reusable role policies.
- Trackers: subscriptions, provider health, last event, backlog and test delivery.
- Security: webhook keys, sessions, audit log, trusted origins and data retention.

Default pages should show four to six decisions, not dozens of controls. Put advanced settings behind progressive disclosure. Every asynchronous action needs explicit idle/loading/success/empty/error/offline/permission-denied states and a request ID for support.

### Design-system and accessibility work

- Create reusable Button, Input, Select, AddressChip, ChainBadge, Card, Table, Modal/Drawer, EmptyState, Skeleton and Toast components from a small token set.
- Remove inline handlers/styles and most `!important`; split portal code by route with lazy loading.
- Standardize one icon set and terminology (`community`, `wallet`, `asset`, `tracker`).
- Label every field; provide descriptions and errors tied with `aria-describedby`; keep 44 px touch targets and clear keyboard focus.
- Use mobile drawer/bottom navigation, card-based tables and a sticky save/test bar.
- Display checksummed/ENS addresses as a copyable chip with chain badge and explorer link.
- Show tracker state as `observed`, `confirming`, `confirmed`, `delayed` or `reorged`; never imply instant finality.
- Replace dead demo CTAs with a real guided sandbox or remove them. Add a trust page covering read-only wallet access, supported chains, provider/status information and security reporting.
- Add Playwright visual regression at 390/768/1440 px, axe accessibility checks and performance budgets.

## Verification performed

- `npm audit --omit=dev --json`: completed; 12 production advisories (2 high, 10 moderate).
- `npm audit fix --dry-run --omit=dev`: completed; no files changed.
- `npm run lint`: completed with 383 findings (26 errors, 357 warnings). The errors are browser-global configuration issues in the collaboration QA tool; the warning volume also reveals the portal's inline-handler architecture.
- Full `npm test`: did not complete within 304 seconds and emitted no streamed result through the runner. The release script executes many isolated child tests serially, so this is an observability and feedback-time problem; it is not recorded as a functional failure.
- Passed targeted checks: portal inline-script safety checker, webhook guards, vault webhook guild binding test and admin tenant-scoping test.
- Browser review: landing and portal at desktop and 390 × 844 mobile widths; DOM, overflow, label and placeholder-link checks.
- Tracked-source secret pattern scan: no obvious live API key/token pattern found. This is not a substitute for a dedicated full-history secret scanner.

## 30/60/90-day delivery plan

### Days 0–30 — secure the base

- Close all three P0 findings.
- Harden OAuth/session/challenge handling and introduce real CSRF tokens.
- Apply safe dependency updates and establish an exception for any unfixable Solana advisory.
- Make address/amount utilities chain-aware and add regression tests.
- Add a durable webhook inbox and instrument queue lag/failures.
- Break the test command into fast unit, integration and release lanes with streamed output.
- Fix mobile header, dead CTAs, infinite loader and top accessibility failures.

**Gate:** zero open P0, no unexplained high dependency advisory, tenant-isolation tests pass, restore and webhook-replay drills pass.

### Days 31–60 — chain-neutral core and EVM verification

- Add namespaced wallet/account, challenge, asset and normalized-event schema.
- Backfill existing records as Solana and dual-read safely.
- Implement chain/provider registry and retain Solana behavior through its adapter.
- Implement Base + Ethereum RPC clients, SIWE and ERC-1271.
- Ship the new connect/verify/revoke UI, chain badges, address chips and audit evidence.
- Begin portal route splitting and design-system migration.

**Gate:** EOA and contract-wallet tests, replay/expiry/origin tests, cross-guild isolation tests, and Solana regression suite all pass.

### Days 61–90 — assets and reliable trackers

- Ship ERC-20/721/1155 balance evaluation and role policies.
- Ship wallet/token/NFT transfer trackers with durable ingestion, confirmation and reorg handling.
- Add reconciliation jobs, provider failover, spam/metadata controls and delivery dead letters.
- Launch the command-center dashboard, onboarding checklist and tracker-health screens.
- Run a limited Base/Ethereum beta before enabling additional networks or trade classification.

**Gate:** replayed provider fixtures are deterministic, simulated reorgs do not duplicate Discord posts, role decisions are explainable by block and balance, accessibility checks pass, and provider outage behavior is visible/recoverable.

## Suggested ownership order

1. Security engineer/backend owner: P0s, session/challenge hardening and webhook durability.
2. Platform owner: chain-neutral schema, migration and provider/event contract.
3. Product frontend owner: component system, onboarding and mobile command center.
4. QA/operations owner: split test lanes, EVM fixtures, reorg drills, visual/accessibility CI and production runbooks.

Only after these foundations are in place should GuildPilot market “EVM support.” The first honest milestone is “EVM wallet verification beta”; token/NFT gating follows, then confirmed transfer trackers, and only then marketplace/DEX trade classification.
