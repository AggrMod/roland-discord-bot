# GuildPilot V2: Multi-Chain & Expansion Roadmap

This document outlines the strategic and technical vision for the **GuildPilot V2 release**. While V1 is optimized to be the ultimate, high-performance Solana community bot, V2 focuses on expanding into a multi-chain powerhouse with enterprise-grade automation and AI integrations.

---

## 0. Superadmin Stability Gate (V1) and V2 Split

The Superadmin V2 Workspace Hub is now the active UI. Before V1 can be considered stable, the following items should be completed in the current release branch. Everything else should move to V2.

### A. Must-Finish for Stable V1 (Do Now)
* **Complete V2-only cleanup**: **DONE**
  * Legacy superadmin tab/panel route-state helpers removed from web/public/portal.js.
  * V2 workspace state and handlers are now the active surface.
* **Finish functional parity for focused Security/Integrations views**: **DONE (V1 scope)**
  * Security and Integrations focused views now open as isolated surfaces with clean back navigation.
  * Visible Integrations controls are wired to save handlers and IDs.
* **Superadmin regression checklist (required before tagging V1)**: **IN PROGRESS**
  * Tenant workspace flows are implemented and stable in current V2 UI.
  * Billing workspace now includes operational actions (approve, reject, override) and status-aware ledger rendering.
  * Full manual signoff checklist run is still required before final V1 tag.
* **Error/observability hardening**: **IN PROGRESS**
  * Workspace and save failure states are scoped and surfaced per action.
  * Telemetry markers remain required for final production signoff.
### B. Move to V2 (Do Later)
* **Advanced Superadmin UX**
  * Dedicated command palette, bulk tenant actions, and batched plan/module operations.
  * Full right-rail activity drilldown and actor profiles.
* **Billing operations expansion**
  * Crypto receipt lifecycle UI (submitted -> pending verification -> approved/failed).
* **Identity operations expansion**
  * Full superadmin identity management in V2 workspace (list/detail/audit/wallet link-unlink) instead of legacy carryover behavior.
* **API and domain restructuring**
  * Consolidate superadmin workspace endpoints into a cleaner domain service layer (`workspaceService`) and remove redundant endpoint shapes once stable.
  * Add paging/sorting for activity and billing streams at scale.

---

## 1. Core Pillar: EVM & Multi-Chain Support
The primary goal of V2 is to transition from a Solana-centric architecture to a chain-agnostic infrastructure.

### A. Modular Chain Provider Interface
* **Interface Decoupling**: Refactor verification, token gating, and tracking services to interact with a unified interface rather than calling Solana-specific libraries directly.
  * `IChainProvider` interface with methods like `verifySignature()`, `getTokenBalance()`, and `getNFTMetadata()`.
* **Solana Provider**: Package existing logic (`@solana/web3.js`, Helius) into a dedicated `SolanaProvider.js`.
* **EVM Provider**: Implement `EVMProvider.js` using `viem` or `ethers.js` to verify Ethereum and EVM-compatible signatures (Polygon, Arbitrum, Optimism, Base).

### B. EVM Wallet & Asset Verification
* **Signature Verification**: Support for EIP-712 typed signing (e.g., via MetaMask/Rainbow) inside the web verification portal.
* **Token Gating standards**: Support ERC-20 (fungible), ERC-721 (NFTs), and ERC-1155 (semi-fungible) role gating rules.
* **EVM Trackers**: Hook up Alchemy or QuickNode webhook streams to feed ERC-20/NFT transfers, swaps, and buys into the Discord alert system.

---

## 2. Advanced Workflow & Automation (Rules Engine)
Move beyond static settings to dynamic, event-driven automation.

* **"If This, Then That" (IFTTT) Engine**:
  * Allow admins to build conditional flows in the Web Portal.
  * *Example*: `IF user links a wallet containing a specific NFT AND has earned 5,000 Engagement Points, THEN assign the VIP role AND post a congratulatory broadcast to #announcements.`
* **Scheduled Announcements**: Advanced broadcast scheduler with recurring posts, templates, and rich-embed layout builders.

---

## 3. Platform Scalability & Performance
Preparing the backend infrastructure to handle hundreds of thousands of concurrent users across thousands of Discord guilds.

* **SQLite to PostgreSQL Migration**:
  * **Database Engine Transition**: Upgrade from a local, single-file `better-sqlite3` instance to a highly available, clustered PostgreSQL database (ideal for scaling to millions of entries and multi-node clusters).
  * **ORM & Query Refactoring**: Introduce a modern ORM (such as Prisma or Sequelize) to replace raw SQLite SQL statements with database-agnostic models, facilitating multi-environment development.
  * **Automated Data Migration Script**: Create a migration utility to automatically convert the SQLite database schema and dump existing tenant, wallet, and user points data into PostgreSQL during upgrade maintenance.
  * **Row-Level Security (RLS)**: Enforce strict multi-tenant boundary checks natively at the database level by mapping `guild_id` to session variables in PostgreSQL.
  * **Docker Development Support**: Provide a standardized `docker-compose.yml` to spin up local PostgreSQL and Redis instances for seamless developer onboarding.
* **Distributed Job Processing**:
  * Replace simple database-polling background queues with a dedicated redis-backed queue (e.g., `bullmq`) running on independent worker nodes.
  * Allows scaling the API backend and background trackers independently.

---

## 4. Next-Gen AI Integrations
Elevate the AI Assistant into an active community moderator and organizer.

* **Interactive Game Masters**: Leverage the AI Assistant to act as a dynamic storyteller and moderator for Heist/Missions and Game Nights.
* **Self-Training Knowledge base**: Set up a scraper that automatically indexes official medium articles, Twitter accounts, and whitepaper updates to keep the bot's Q&A memory fresh without manual admin uploads.
* **Auto-Moderation via AI**: Use lightweight LLM classification or vector filters to detect toxic behavior, spam waves, or compromised account warnings before standard filters catch them.

---

## 5. Monetization & Subscription Expansion
* **Dynamic Billing Models**: Integrate Stripe/Solana Pay subscription billing directly into the Web Portal.
* **Granular Plan Gating**: Enforce real-time rate limits (e.g., Helius webhook limits, AI token usage caps) based on the tenant's tier level.


