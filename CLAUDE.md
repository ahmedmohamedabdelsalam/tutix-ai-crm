# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# TUTIX AI CRM — NestJS Backend

WhatsApp AI agent backend for Hajj & Umrah companies in Egypt. Multi-tenant: every company gets its own WhatsApp number and AI agent. Deployed on Railway.

## Stack
- NestJS + TypeScript
- PostgreSQL (Supabase) + Prisma v7 with `@prisma/adapter-pg` (driver adapter pattern — no direct TCP, uses `pg` Pool)
- Groq AI in dev (`llama-3.3-70b-versatile`) / OpenAI-compatible endpoint in prod — model always from `AI_MODEL` env
- Meta WhatsApp Cloud API

## Commands

```bash
npm run start:dev       # watch mode (dev)
npm run build           # tsc compile → dist/
npm run start:prod      # node dist/src/main.js
npm run test            # jest unit tests
npm run test:e2e        # jest e2e (test/jest-e2e.json)
npx prisma generate     # regenerate client after schema change
npx prisma db push      # apply schema to DB without migration history (used here — not migrate dev)
node test-local.js      # POST /webhook/test against localhost:3001
node test-live.js       # POST /webhook/test against Railway production
```

Build for Railway: `npm install && npm run build` → start: `node dist/src/main.js`

## Architecture

Single NestJS app with three modules:

### WhatsApp Module (`src/whatsapp/`)
- **Controller** handles three routes:
  - `GET /webhook` — Meta webhook verification (checks `WEBHOOK_VERIFY_TOKEN`)
  - `POST /webhook` — Meta webhook receiver; **must return 200 immediately**, then process async (Rule 3)
  - `POST /webhook/test` — dev/test endpoint, takes `{phone, message}`, returns `{reply}`
- **Service** (`whatsapp.service.ts`) owns the full conversation loop:
  1. Look up company by `companyId` (from `DEFAULT_COMPANY_ID` env for now — single-tenant webhook)
  2. Find or create `Conversation` (status: `AI_HANDLING`)
  3. Save incoming message as `USER` role
  4. Call `getAgentReply()` with conversation history + company packages + aiPrompt
  5. Save reply as `ASSISTANT` role
  6. Call `extractLeadData()` → `calculateScore()` → update `Lead`
  7. Call `shouldHandoff()` → if yes, set `status: NEEDS_HUMAN`, save closing message

### Agent Module (`src/agent/agent.service.ts`)
Pure functions (no NestJS injectable), exported and called directly:
- `buildSystemPrompt(companyName, packages, aiPrompt)` — assembles Arabic system prompt; appends `aiPrompt` section if non-empty
- `getAgentReply(history, companyName, packages, aiPrompt?)` — calls AI, returns Arabic reply
- `extractLeadData(history)` — calls AI with `temperature:0` to extract structured JSON
- `calculateScore(data)` — deterministic: name=20, groupSize=15, budget=25, travelDate=25, packageType=15
- `shouldHandoff(score, msgCount, data)` — triggers at score≥70, msgCount≥10, or `isReadyToBook=true`

### Subscription Module (`src/subscription/`)
Cron job runs daily at 9 AM (`@Cron('0 9 * * *')`):
- Warns on companies expiring within 7 days (logs only — email TODO)
- Auto-deactivates companies past `subscriptionEnd`

### Prisma (`src/prisma/`)
`PrismaService` extends `PrismaClient` with `PrismaPg` driver adapter. Uses a `pg.Pool` from `DATABASE_URL`. Connects on `onModuleInit`, tears down pool on `onModuleDestroy`.

## Rules — Never Break
1. Every DB query MUST have `companyId` filter (multi-tenant isolation)
2. AI model always from `AI_MODEL` env — never hardcoded
3. Always return 200 to Meta webhook immediately (before any async work)
4. All user-facing messages in Arabic

## Key Env Vars
| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Supabase pooler (port 6543) — used at runtime |
| `DIRECT_URL` | Supabase direct (port 5432) — used for `prisma db push` |
| `AI_BASE_URL` | OpenAI-compatible base URL (Groq in dev) |
| `AI_API_KEY` | AI provider key |
| `AI_MODEL` | Model name — never hardcode in source |
| `DEFAULT_COMPANY_ID` | Maps Meta webhook to a company (single-tenant for now) |
| `WEBHOOK_VERIFY_TOKEN` | Meta webhook verification handshake |
| `PORT` | HTTP port, defaults to 3001 |

## Lead Score
`name`=20, `groupSize`=15, `budget`=25, `travelDate`=25, `packageType`=15  
score ≥ 70 → HOT → handoff to Sales (conversation status → `NEEDS_HUMAN`)

## Prisma Schema Notes
- Schema lives in `prisma/schema.prisma`; DB is shared with `tutix-dashboard` (Next.js)
- Always run `npx prisma generate` after schema changes
- Use `npx prisma db push` (not `migrate dev`) — migration history was not bootstrapped
- After adding fields here, also update `tutix-dashboard/prisma/schema.prisma` and regenerate
