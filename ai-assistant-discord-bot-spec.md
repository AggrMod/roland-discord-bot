# AI Assistant Discord Bot Specification

## Purpose

This document defines the architecture, design choices, scaling model, and implementation plan for a Discord AI assistant bot with a controlled **mafia / Family vibe**, suitable for integration into **Guild Pilot** or a similar Discord bot platform.

The goal is to build a bot that can:
- Read messages in selected Discord channels
- Respond in a controlled, stylized "Family" tone
- Answer support and project questions accurately
- Scale across many servers without becoming spammy or brittle
- Use modern LLMs through **APIs**, not CLI tooling, for production message handling

---

## Core Conclusion

Yes, this bot is very feasible.

The correct production design is:
- **Discord bot + backend orchestration + AI APIs + knowledge layer + safety/rate-limit controls**
- **API-based AI integration** for live Discord behavior
- **CLI tools** only for development, coding, prompt iteration, automation, and repo work

For a live Discord bot, the connected AIs should be **API-based**, not CLI-based.

---

## What the Bot Should Do

### Functional goals
- Read messages from one or more channels
- Decide whether to respond
- Respond in a mafia / Family vibe without becoming parody-like
- Answer questions about project rules, mint, roadmap, roles, verification, lore, and community processes
- Support mention-based replies and optionally passive replies in approved channels
- Operate differently by channel type and context

### Example bot roles
- Family concierge
- Verification helper
- Mint guide
- Lore explainer
- Community support assistant
- Future RPG/world bridge

---

## Recommended Tech Stack

### Preferred stack
- **Node.js**
- **TypeScript**
- **discord.js**
- **PostgreSQL** or SQLite for early builds
- **OpenAI API**
- **Gemini API**

### Helpful extras
- Redis for cooldowns and short-lived queues
- Drizzle ORM or Prisma
- Winston or Pino for logging
- Zod for validation
- PM2 or Docker for deployment

### Why this stack
- `discord.js` is strong for production Discord bots
- TypeScript helps keep a growing modular bot sane
- easy to extend later into governance, verification, knowledge retrieval, tickets, RPG integration, and persona switching

---

## API vs CLI

### Production/live Discord behavior
Use **APIs**.

The correct runtime path is:

```text
Discord event/message
   -> Guild Pilot backend
   -> routing logic
   -> OpenAI API or Gemini API
   -> reply back to Discord
```

### Development workflow
Use **CLI tools**.

Examples:
- Codex CLI for coding features, refactors, tests, scripts, migrations
- Gemini CLI for code work, local agent tasks, batch implementation help

### Do not use CLI for live bot replies
Avoid this production pattern:

```text
Discord -> spawn CLI process -> parse terminal output -> reply
```

That design is slower, harder to scale, harder to secure, and harder to observe.

### Rule of thumb
- **API** = production bot intelligence
- **CLI** = building and maintaining the bot

---

## High-Level Architecture

Use this pipeline:

```text
Discord Message
   ↓
Message Filter
   ↓
Trigger Router
   ↓
Context Builder
   ↓
Knowledge Retriever
   ↓
Model Router (GPT / Gemini)
   ↓
Style + Safety Post-Processor
   ↓
Discord Reply
   ↓
Log + Store Interaction
```

### Layer breakdown

#### 1. Discord layer
Handles:
- message events
- slash commands
- permissions
- channel filtering
- cooldown checks
- replying to users

#### 2. Orchestrator layer
Handles:
- model routing
- context assembly
- reply policy
- prompt construction
- result normalization

#### 3. Knowledge + memory layer
Handles:
- FAQ
- roadmap
- rules
- verification guide
- mint details
- lore
- recent channel context
- optional user state

#### 4. Safety + admin layer
Handles:
- anti-spam
- blocked topics
- channel allowlists
- admin controls
- rate limiting
- confidence thresholds
- logging and diagnostics

---

## Best Initial Operating Modes

### Mode 1 — Mention-only
The bot only replies when tagged.
- safest
- easiest to control
- best starting point

### Mode 2 — Controlled passive replies
The bot replies in specific channels when keywords match.
- good for support/help channels
- still manageable

### Mode 3 — Full character presence
The bot actively participates in a themed channel.
- immersive
- higher spam/cost/rate-limit risk
- should only be used in selected channels

### Recommended rollout
Start with:
- mention replies globally
- passive replies only in one or two dedicated channels such as `#ask-the-family` or `#mint-help`

---

## Recommended Channel Strategy

Suggested setup:
- `#ask-the-family` → AI replies freely
- `#general` → mention-only replies
- `#verification-help` → support mode
- `#mint-help` → support mode with mint context
- `#lore-room` → lore/family mode
- `#staff-bot-logs` → internal logging
- admin slash commands for configuration

This is much better than letting the bot speak in every channel.

---

## Persona Design

The bot should feel like:
- a consigliere
- a gatekeeper to the Family
- calm, loyal, composed, dark, respectful

It should **not** feel like:
- a cartoon gangster parody
- a meme machine
- unreadable slang spam

### Tone principles
- confident
- slightly theatrical
- concise by default
- accurate first, style second
- immersive without sacrificing clarity

### Good style cues
Use phrases like:
- the Family
- our house
- your place at the table
- the books
- the gate

Use them sparingly.

### System prompt example

```text
You are the Family AI for this Discord server.

Your role:
- Help members with project info, minting, verification, roles, roadmap, and lore.
- Speak with a refined mafia-family tone: confident, mysterious, loyal, and composed.
- Prioritize clarity and correctness over theatrics.
- Never become parody-like or overloaded with slang.
- Keep replies concise in active channels.
- In lore channels, you may lean further into the Family persona.

Behavior rules:
- If you do not know something, say so clearly.
- Do not invent mint details, prices, rules, or benefits.
- Use project knowledge provided by the system first.
- If the question is about verification, explain the next step simply.
- If the user is frustrated, remain calm and respectful.
- Avoid repeating the same catchphrases too often.
```

---

## GPT vs Gemini Split

### GPT
Use for:
- live Discord replies
- persona-rich responses
- support answers that need polished tone
- short-to-medium interactive output

### Gemini
Use for:
- long-context summarization
- background analysis
- processing larger docs
- fallback or alternate provider

### Recommended practical split
- **GPT = default responder**
- **Gemini = background helper / fallback / long-context assistant**

That gives more consistent community-facing behavior.

---

## Knowledge Layer Design

Do not overcomplicate retrieval in v1.

Start with structured local files:

```text
knowledge/
  faq.json
  mint.json
  verification.json
  roadmap.json
  lore.json
  rules.json
  roles.json
  announcements.json
```

### Example structure

```json
{
  "title": "Mint Information",
  "items": [
    {
      "topic": "og_phase",
      "keywords": ["og", "free mint", "og role"],
      "content": "OG members receive 1 free mint after wallet verification through Guild Pilot."
    },
    {
      "topic": "wl_phase",
      "keywords": ["wl", "whitelist", "discount"],
      "content": "Whitelist members can mint up to 10 NFTs at 0.1 SOL during the WL phase."
    }
  ]
}
```

### Retrieval strategy for v1
- keyword match
- topic match
- curated metadata
- small injected context blocks

### Upgrade path later
- embeddings
- semantic search
- vector DB
- document ranking
- hybrid retrieval

For a support/community Discord bot, curated JSON/Markdown often works very well before you need heavier RAG.

---

## Memory Design

Start with **short-term operational memory**, not deep user memory.

### Keep
- last 5–15 channel messages
- current user message
- last bot reply
- channel mode
- user roles
- maybe verification state

### Avoid early
- persistent emotional memory
- long user profiling
- storing unnecessary personal details

### Why
Short-term context is enough for coherent Discord replies without adding complexity, privacy issues, or drift.

---

## Confidence-Based Answering

A major rule:
**The bot should not pretend to know things it does not know.**

If retrieval is weak, or a detail is not in the current knowledge base, the bot should respond clearly and safely.

### Good fallback example
> That answer isn’t on the books I’ve been given. A staff member should confirm that one.

This is much better than hallucinating mint details, roadmap promises, wallet states, or moderation outcomes.

---

## Reply Policy

### Always reply when
- the bot is mentioned
- the user uses slash commands such as `/ask`, `/family`, `/verifyhelp`, `/minthelp`
- the message is in a dedicated AI/help channel

### Sometimes reply when
- trigger keywords match
- passive replies are enabled for the channel
- confidence is high enough
- cooldown allows it

### Never reply when
- the channel is not allowed
- the message is from another bot
- the content is off-limits or unsafe
- the bot lacks confidence/context
- the server/channel policy requires mention-only behavior

---

## Recommended Commands

Suggested slash commands:
- `/ask` → general question to the bot
- `/family` → more immersive mafia-style answer
- `/minthelp` → mint guidance
- `/verifyhelp` → verification guidance
- `/lore` → lore-specific answer
- `/mode` → set channel mode
- `/persona` → support/family/lore/plain mode
- `/botstatus` → admin usage/status info
- `/reloadknowledge` → reload docs/JSON
- `/silence` → disable passive replies in a channel

---

## Folder Structure

```text
family-bot/
├─ package.json
├─ tsconfig.json
├─ .env
├─ src/
│  ├─ index.ts
│  ├─ bot/
│  │  ├─ client.ts
│  │  ├─ registerCommands.ts
│  │  ├─ events/
│  │  │  ├─ ready.ts
│  │  │  ├─ interactionCreate.ts
│  │  │  ├─ messageCreate.ts
│  │  │  └─ guildCreate.ts
│  │  └─ commands/
│  │     ├─ ask.ts
│  │     ├─ family.ts
│  │     ├─ verifyhelp.ts
│  │     ├─ minthelp.ts
│  │     ├─ lore.ts
│  │     ├─ mode.ts
│  │     ├─ persona.ts
│  │     └─ config.ts
│  │
│  ├─ ai/
│  │  ├─ orchestrator.ts
│  │  ├─ providers/
│  │  │  ├─ openaiProvider.ts
│  │  │  ├─ geminiProvider.ts
│  │  │  └─ providerTypes.ts
│  │  ├─ prompts/
│  │  │  ├─ systemPrompt.ts
│  │  │  ├─ personaPrompts.ts
│  │  │  ├─ supportPrompt.ts
│  │  │  ├─ lorePrompt.ts
│  │  │  └─ safetyPrompt.ts
│  │  ├─ routing/
│  │  │  ├─ modelRouter.ts
│  │  │  ├─ triggerRouter.ts
│  │  │  └─ replyPolicy.ts
│  │  └─ postprocess/
│  │     ├─ cleanResponse.ts
│  │     ├─ lengthControl.ts
│  │     └─ toneGuard.ts
│  │
│  ├─ context/
│  │  ├─ contextBuilder.ts
│  │  ├─ recentMessages.ts
│  │  ├─ roleContext.ts
│  │  ├─ channelMode.ts
│  │  └─ userState.ts
│  │
│  ├─ knowledge/
│  │  ├─ loader.ts
│  │  ├─ retriever.ts
│  │  ├─ keywordSearch.ts
│  │  ├─ ranking.ts
│  │  └─ files/
│  │     ├─ faq.json
│  │     ├─ mint.json
│  │     ├─ verification.json
│  │     ├─ roadmap.json
│  │     ├─ roles.json
│  │     ├─ lore.json
│  │     ├─ rules.json
│  │     └─ announcements.json
│  │
│  ├─ moderation/
│  │  ├─ safetyFilter.ts
│  │  ├─ blockedTopics.ts
│  │  ├─ rateLimit.ts
│  │  ├─ mentionPolicy.ts
│  │  └─ channelAllowlist.ts
│  │
│  ├─ db/
│  │  ├─ client.ts
│  │  ├─ schema.ts
│  │  ├─ queries/
│  │  │  ├─ guildSettings.ts
│  │  │  ├─ channelSettings.ts
│  │  │  ├─ userProfiles.ts
│  │  │  ├─ conversationLogs.ts
│  │  │  └─ usageLogs.ts
│  │  └─ migrations/
│  │
│  ├─ services/
│  │  ├─ discordReplyService.ts
│  │  ├─ loggingService.ts
│  │  ├─ verificationService.ts
│  │  ├─ mintInfoService.ts
│  │  └─ adminConfigService.ts
│  │
│  ├─ config/
│  │  ├─ env.ts
│  │  ├─ defaults.ts
│  │  └─ constants.ts
│  │
│  ├─ utils/
│  │  ├─ logger.ts
│  │  ├─ errors.ts
│  │  ├─ time.ts
│  │  └─ text.ts
│  │
│  └─ types/
│     ├─ ai.ts
│     ├─ discord.ts
│     ├─ config.ts
│     └─ knowledge.ts
│
├─ scripts/
│  ├─ importKnowledge.ts
│  ├─ seedGuildConfig.ts
│  └─ testPrompt.ts
│
└─ README.md
```

---

## Database Design

### `guild_settings`
- guild_id
- default_model
- default_persona
- bot_enabled
- passive_reply_enabled

### `channel_settings`
- guild_id
- channel_id
- mode (`support`, `family`, `lore`, `plain`)
- passive_enabled
- require_mention
- max_reply_length

### `conversation_logs`
- id
- guild_id
- channel_id
- user_id
- message_id
- prompt_excerpt
- response_excerpt
- provider
- tokens
- created_at

### `user_profiles`
- guild_id
- user_id
- verified_status
- wallet_linked
- holder_tier
- preferred_name

### `usage_logs`
- provider
- model
- tokens_in
- tokens_out
- estimated_cost
- created_at

---

## Scaling and Rate-Limit Reality

### Important principle
Discord rate limits are based on **request volume**, not server count alone.

A quiet bot can live in many servers.
A noisy bot can get rate-limited in far fewer servers.

### Main practical pressure points
1. Sending too many messages at once
2. Too many edits/follow-ups
3. Too many role/channel/member REST requests
4. Poor retry behavior after errors
5. No queueing or throttling
6. Passive replies in too many channels

### Safe interpretation
- a mention-based bot can often scale to many servers without issue
- a highly chatty auto-reply bot can run into trouble much sooner

### Practical guidance
- mention-only globally is safe
- passive replies should be limited to selected AI/help channels
- queue outbound sends/edits
- cache guild/channel/member state where possible
- keep replies concise in active channels

### Sharding mindset
Even when rate limits are not yet the main problem, architecture should be written so sharding can be added later without major rewrites.

---

## Capacity Model

The useful planning model is not “How many servers?” but:

**Servers × active users × bot-triggering messages × Discord actions per trigger × peak burst behavior**

### Step 1 — Estimate inbound triggers
Formula:

```text
servers × active_users_per_day_per_server × bot_trigger_rate
```

Example:

```text
100 servers × 40 active users/day × 0.3 bot triggers per user/day = 1,200 triggers/day
```

### Step 2 — Estimate Discord actions per trigger
Each trigger may cause:
- typing indicator
- send message
- edit message
- permission/member lookup
- logging or follow-up work

A lean bot should aim for roughly **1–3 Discord REST actions per response**.

### Step 3 — Model peak bursts
Average traffic rarely causes the biggest problem.
Announcements, raids, or hype spikes do.

Estimate:

```text
peak_triggers_per_second × actions_per_trigger = peak_requests_per_second
```

This is the key number for Discord pressure.

### Example scenarios

#### Scenario A — Safe
- 200 servers
- mention-only outside dedicated AI channels
- 1–2 REST actions per response
- cooldowns enabled

This is likely manageable.

#### Scenario B — Risky
- 50 servers
- passive replies in general chat
- multiple replies/edits per trigger
- member lookups and role actions per event

This can hit limits much sooner.

---

## Cost and Load Control

### Must-have controls
- channel allowlists
- mention-only default mode
- per-channel cooldowns
- short context windows
- concise reply limits
- queue for outbound Discord actions
- caching of state and FAQs
- confidence threshold before answering

### Smart strategy
- mention replies: yes
- passive replies: only in approved channels
- long answers: only when explicitly asked
- large docs: summarize offline/background first

---

## Security

### Rules
- keep API keys in environment variables
- never commit API keys
- never expose provider calls directly from client-side code
- use separate dev and prod tokens
- log admin config changes
- restrict admin commands to admins/mods
- never let the bot respond to itself or other bots

### Deployment recommendation
Use a separate VPS/container from your website and critical production bot systems.

Suggested starting VPS:
- 2 vCPU
- 4–8 GB RAM
- Linux
- Node app under PM2 or Docker
- PostgreSQL local or managed

No GPU is required.

---

## Suggested Implementation Phases

### Phase 1 — Foundation
- bot login
- `messageCreate` event
- mention-only behavior
- basic GPT API integration
- one mafia-family persona prompt
- logging and cooldowns

### Phase 2 — Structured support bot
- slash commands
- knowledge JSON files
- retrieval by keyword/topic
- support/lore/family channel modes
- Gemini fallback
- admin config commands

### Phase 3 — Production hardening
- queueing/throttling
- better logs and diagnostics
- shard-ready design
- metrics and usage tracking
- stronger safety filters
- confidence thresholds

### Phase 4 — Enrichment
- embeddings / semantic retrieval
- role-aware replies
- verification-aware answers
- summaries for staff
- RPG/world integration

---

## Build Order

Recommended order of execution:
1. Bot skeleton and Discord events
2. Mention-based GPT replies
3. Persona prompt and tone control
4. Channel allowlist and cooldowns
5. Structured knowledge files
6. Retrieval layer
7. Gemini fallback
8. Slash commands
9. Database logging
10. Admin controls and channel modes

This keeps the build stable and reduces complexity.

---

## What Not To Do First

Avoid these in v1:
- full multi-agent swarm architecture
- deep persistent user memory
- vector DB before your docs are organized
- passive replies across the whole server
- heavy roleplay that harms usability
- tool-calling into critical systems before you trust the bot

Start narrow and controlled.

---

## Recommended v1 for Guild Pilot

A strong first release would be:
- `discord.js` + TypeScript
- GPT API as default responder
- Gemini API as secondary/background helper
- local JSON knowledge base
- mention replies globally
- passive replies only in `#ask-the-family` or similar
- support/family/lore modes
- admin commands for configuration
- logs, cooldowns, and queueing

That gives a usable, scalable first product without overengineering.

---

## Future Expansion

Later, the assistant can evolve into:
- holder-aware assistant
- governance explainer
- lore master / faction guide
- ticketing companion
- RPG mission dispatcher
- rank-aware world bridge inside your ecosystem

The most important thing is to build the first version as a **reliable assistant with style**, not a style bot without reliability.

---

## Final Summary

The right architecture is:
- **Discord bot + backend orchestration + AI APIs + structured knowledge + strong controls**

The right AI integration choice is:
- **API for production**
- **CLI for development**

The right rollout is:
- mention-based first
- selected passive channels second
- full immersion only where appropriate

The right design principle is:
- **support bot first, character bot second**

That is the cleanest path to a high-quality mafia-style Discord AI assistant that can live inside Guild Pilot and scale sensibly.
