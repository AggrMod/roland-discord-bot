# QA Signoff Collab App (Standalone)

This is a separate collaborative QA signoff app for V1. It is **not part of the bot runtime**.

## What it does
- Shared signoff board for all V1 module checks.
- Persistent storage in SQLite.
- Optional write protection using admin token.
- JSON export for release evidence.
- Findings register with required decision:
  - `Implement for V1`
  - `Move to Roadmap`
- Auto-generated findings report (Markdown).
- Per-check tester guidance (`How to test`) shown in the board.

## Start locally
From repo root:

```powershell
node tools/qa-signoff-collab/server.js
```

Open:
- `http://localhost:4310`

## Optional env vars
- `QA_SIGNOFF_PORT` (default `4310`)
- `QA_SIGNOFF_DB_PATH` (default `tools/qa-signoff-collab/data/qa-signoff.db`)
- `QA_SIGNOFF_TEMPLATE_PATH` (default `tools/qa-signoff/signoff-template.json`)
- `QA_SIGNOFF_ADMIN_TOKEN` (if set, write endpoints require this token)

## Deploy on your webspace
1. Deploy this folder and run `server.js` with Node.
2. Keep the SQLite DB path on persistent disk.
3. Set `QA_SIGNOFF_ADMIN_TOKEN` in host env.
4. Put it behind HTTPS and basic auth/reverse-proxy auth if possible.

## API
- `GET /api/health`
- `GET /api/board`
- `PUT /api/board/check` (token required if configured)
- `GET /api/findings`
- `POST /api/findings` (token required if configured)
- `PUT /api/findings/:id` (token required if configured)
- `GET /api/findings/report` (returns grouped counts + Markdown report)
- `GET /api/export`
