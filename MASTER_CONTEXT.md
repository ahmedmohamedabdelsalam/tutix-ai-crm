# TUTIX AI CRM — Master Context File

**Purpose:** Single source of truth for any Claude session working on this project. Read this before doing anything else.

---

## Section 1: Project Overview

**TUTIX** is an AI-powered multi-tenant SaaS CRM for Egyptian Hajj & Umrah travel companies. Each company gets its own WhatsApp number and AI sales agent that handles customer inquiries in Arabic, qualifies leads, and escalates to human agents when needed.

### Current Live Client
- **Alex International Travel** (إسكندرية الدولية للسياحة)
- Sells Hajj and Umrah packages; 4 branches (Alexandria, Cairo, Port Said, Damietta)
- Has 607 real permanent customer records in the DB

### Live URLs
| Service | URL |
|---|---|
| Customer Dashboard | https://app.tutix.net |
| Admin Panel | https://app.tutix.net/admin |
| Backend API | https://tutix-ai-crm-production.up.railway.app |
| WhatsApp Webhook | https://tutix-ai-crm-production.up.railway.app/webhook |

### Tech Stack
| Layer | Technology |
|---|---|
| Backend | NestJS + TypeScript — deployed on Railway |
| Frontend | Next.js 14 App Router — deployed on Vercel |
| Database | PostgreSQL via Supabase (shared schema between both repos) |
| AI | Claude Haiku (`claude-haiku-4-5-20251001`) via Anthropic API |
| Messaging | Meta WhatsApp Business Cloud API |
| ORM | Prisma v7 with `@prisma/adapter-pg` (driver adapter, no direct TCP) |

### GitHub Repos
- Backend: `ahmedmohamedabdelsalam/tutix-ai-crm`
- Frontend: `ahmedmohamedabdelsalam/tutix-dashboard`

---

## Section 2: Credentials & Access

> **IMPORTANT:** Never commit credentials to git. These are for Claude's reference only during authorized sessions.

| System | Login | Password | Landing Page |
|---|---|---|---|
| TUTIX Admin | ahmed@tutix.com | Ahmed20032005 | /admin/companies |
| Alex Admin | mr.sherif@alex-travel.com | Sherif@2026 | /crm/dashboard |

### Infrastructure Access
- **Railway:** `tutix-ai-crm` service (Hobby plan, $10/month)
- **Vercel:** `tutix-dashboard` project (auto-deploys from GitHub main branch)
- **Supabase:** `tutix` project (shared DB between backend and frontend)

### Session Cookie (Admin Auth)
- Cookie name: `tutix_session`
- Type: httpOnly JWT signed with `JWT_SECRET` env var
- Verified via `verifyToken()` from `@/lib/auth`
- All `/api/admin/*` and `/api/companies/*` routes require this cookie

---

## Section 3: Architecture Decisions

### 1. Multi-Tenant Isolation
Every single DB query **must** include `companyId` as a filter. This is Rule #1 and is never negotiable. No exceptions.

```typescript
// CORRECT
prisma.lead.findMany({ where: { companyId, phone } })

// WRONG — data leak across tenants
prisma.lead.findMany({ where: { phone } })
```

### 2. Message History Window
Only the **last 10 messages** from a conversation are passed to the AI. This is a deliberate cost optimization. Older messages are in the DB but not sent to Claude.

### 3. Confirmed Facts Injection (`buildKnownFactsBlock()`)
Because the history window is only 10 messages, early confirmed facts (name, group size, service type, travel date) would fall out of context. `buildKnownFactsBlock()` in `whatsapp.service.ts` persists these as structured context injected into every AI call, independent of the history window.

```typescript
// Injects confirmed data regardless of history length
buildKnownFactsBlock({ serviceType, groupSize, travelDate, ... })
```

### 4. Prompt Caching
Active and working. System prompt is cached at ~30,516 tokens. This dramatically reduces per-message cost because the large catalog + personality prompt is only billed on cache write, not cache read.
- Cache reads: ~$0.0003 per message
- Cache writes: happen when prompt changes (new programs, new personality)

### 5. Cost Per Conversation
- Average: **~$0.055 per full conversation** (from lead to handoff)
- Per message: **~$0.002–0.006** (with cache hits)
- Extract call: **~$0.001** (every 5th message, runs at temperature 0)

### 6. AI Model
`claude-haiku-4-5-20251001` — set via `AI_MODEL` env var on Railway. **Never hardcode a model name in source.** The model is always read from `process.env.AI_MODEL`.

### 7. CompanyAIConfig — DB-Backed Catalog System
Alex's AI content (Umrah programs, Hajj programs, hotels, branches, personality) lives in the `CompanyAIConfig` DB table. Two code paths exist:
- **Static path** (`USE_DB_CATALOG=false`): reads from `.ts` files in `src/agent/prompts/`
- **DB path** (`USE_DB_CATALOG=true`): reads from `CompanyAIConfig.catalog` and `.industryData`

As of the last session, the DB path has been verified as safe for Alex (9 Hajj programs, 31 Umrah programs, 10 hotels — all confirmed). **Switching `USE_DB_CATALOG=true` on Railway is ready and approved.**

The `dynamic-catalog-builder.ts` makes **zero AI API calls** — it only reads from Prisma and formats text.

### 8. Server-Side Time (Attendance)
`checkInAt` and `checkOutAt` on `AttendanceRecord` are **always** set from `new Date()` on the server, never from the client request body. This prevents clock manipulation.

### 9. GPS Radius (Attendance)
200 meters is the maximum allowed distance between the employee's reported GPS coordinates and the registered branch coordinates for a valid check-in.

### 10. Two-Repo, Shared DB Pattern
Both `tutix-ai-crm` (NestJS) and `tutix-dashboard` (Next.js) have their own `prisma/schema.prisma`. Any schema change must be applied to **both** schemas and regenerated in both projects. Use `npx prisma db push` (not `migrate dev`) — migration history was never bootstrapped.

---

## Section 4: Critical Guardrails — Never Remove

These are production safety mechanisms. Do not remove, simplify, or "clean up" any of these.

### 1. Hajj Date Disclaimer (`applyHajjDateDisclaimer()`)
**Location:** `src/whatsapp/whatsapp.service.ts`

A **code-level guard** (not prompt-only) that appends "تقريباً" and the official-announcement disclaimer to any message mentioning Hijri 1448H Hajj dates. This is legally/religiously important — Hijri dates are estimates until the official moon sighting.

```typescript
// Triggers on: 'ذي الحجة ١٤٤٨' OR ('ذي الحجة' + '2027' in same message)
// Appends: standard disclaimer about official announcement after moon sighting
```

### 2. Installment (تقسيط) Policy
- Installments are **NOT available** except at the Port Said branch
- Contact for installment: **+20 122 2556932** (agent: أفيلابول)
- AI must never invent installment terms, percentages, or timelines
- Rule lives in `base-personality.ts` under "قاعدة التقسيط" section

### 3. WON Status Access Control
Only roles `ACCOUNTANT` or `COMPANY_ADMIN` can set a lead/conversation to `WON` status. `AGENT` and `SALES_MANAGER` get HTTP 403. Enforced server-side in the pipeline API.

### 4. `buildKnownFactsBlock()` — Never Remove
This function keeps confirmed customer facts alive across the 10-message window. Removing it would cause the AI to re-ask for name/group size/service type on every conversation after the context window slides.

### 5. `needsSalesContact` Flag
When the AI detects the customer is ready to pay and after 2 consecutive failures, it sets `needsSalesContact: true` on the conversation. This triggers a red alert in the sales inbox and escalates to human. Do not bypass this with silent error swallowing.

### 6. `handledByUserId` Soft-Lock
Prevents two sales agents from replying to the same conversation simultaneously. A conversation is "soft-locked" to a user for 2 minutes of inactivity. After 2 minutes, the lock auto-clears. Do not remove this.

### 7. `ApiCreditsExhaustedError`
When Anthropic API credits run out, the system creates a `SystemNotification` and stops the conversation gracefully. It does **not** send an error message to the customer and does **not** loop. The credit balance is tracked via `ANTHROPIC_CREDIT_BALANCE_USD` env var.

### 8. Server-Side Attendance Times
`AttendanceRecord.checkInAt` and `.checkOutAt` are always set server-side. The client only sends GPS coordinates and optional notes. If client-provided timestamps were used, employees could fake attendance times.

---

## Section 5: AI Agent Behavior Rules

These live in `src/agent/prompts/base-personality.ts`. They define how the Arabic sales agent behaves.

### Service Type Determination
- **Never assume** whether a customer wants Hajj or Umrah
- The agent must get an explicit answer before showing any programs
- Even if the customer says "رحلة مكة" — ask whether it's Hajj or Umrah

### Group Size Parsing
| Customer says | Interpreted as |
|---|---|
| "والدي بس" | 1 person |
| "أنا ووالدي" | 2 persons |
| "عيلتي زوجتي وطفلين" | Confirm before recording (could be 3 or 4) |
| "أنا وزوجتي وأطفالي الثلاثة" | 5 persons |

Always confirm ambiguous group sizes before presenting pricing.

### Date Display
Every date must show **both** Gregorian and Hijri formats. Never show only one.

### No Repeated Questions
If the AI asked a question and got no answer, it may ask once more with new context. After the second unanswered attempt, it must move forward or offer an alternative.

### Context Preservation on Off-Topic Responses
If a customer provides their name in response to a yes/no question, the AI must:
1. Register the name (update confirmed facts)
2. Still answer the original question it asked

### Programs Shown by Departure Month Only
Never show programs by arrival month or "month when you're in Mecca." All program listings are organized by the departure date month.

### Installment Questions
Always redirect to Port Said branch and the phone number +20 122 2556932. Never invent terms, amounts, or percentages.

### Absolute Prohibitions
- No fake discounts (never promise a % off without management approval)
- No invented phone numbers
- No invented hotel names or ratings
- No Hijri dates without "تقريباً" qualifier (for 1448H Hajj)

---

## Section 6: Database Models

All models in `prisma/schema.prisma`. Every model has `companyId` except system-level models.

| Model | Purpose |
|---|---|
| `Company` | Multi-tenant root. One per travel company. Contains `waToken`, `aiPrompt`, subscription dates |
| `User` | Employees. Roles: `COMPANY_ADMIN`, `SALES_MANAGER`, `AGENT`, `ACCOUNTANT` |
| `Lead` | Potential customers in sales pipeline. Has score (0–100), pipeline stage |
| `PermanentCustomer` | Confirmed paying customers. Alex has 607 real records |
| `Conversation` | WhatsApp chat thread. Status: `AI_HANDLING`, `NEEDS_HUMAN`, `CLOSED` |
| `Message` | Individual messages in a conversation. Role: `USER` or `ASSISTANT` |
| `Payment` | Financial transactions linked to leads |
| `CompanyFAQ` | Company-specific Q&A injected into AI context |
| `CompanyAIConfig` | DB-backed AI catalog: `catalog` (JSON), `salesPersonality` (text), `industryData` (JSON) |
| `Branch` | Office locations with GPS coordinates (`lat`, `lng`, `radiusMeters`) |
| `AttendanceRecord` | Employee check-in/check-out. Times always from server |
| `DailyTask` | Manager-created reminders with completion tracking |
| `SystemNotification` | System alerts: API credit exhaustion, token expiry, sales escalation |
| `AgentInsight` | AI analytics per conversation: cost, message count, lead score |

### CompanyAIConfig JSON Shape
```typescript
// catalog field shape (for HAJJ_UMRAH industry type):
{
  umrahPrograms: UmrahProgram[],    // 31 programs for Alex
  hajjPrograms: HajjProgram[],      // 9 programs for Alex
  hotelBookingLinks: Record<string, string>,
  hajj: [...],                      // legacy flat format, not used by builder
  hajjUpdatedAt: string,
  hajjProgramCount: number,
}

// industryData field shape:
{
  branches: Array<{ city, address, note? }>,
  companyDescription: string,
  hotels: HotelEntry[],             // 10 hotels for Alex
  hajjHijriDates: Array<{ hijri, gregorian }>,
  installmentContact: { city, agentName, phone },
}
```

### Lead Score Formula
`name`=20, `groupSize`=15, `budget`=25, `travelDate`=25, `packageType`=15
- Score ≥ 70 → HOT → handoff to sales (conversation → `NEEDS_HUMAN`)

---

## Section 7: Environment Variables

### tutix-ai-crm (Railway)

| Variable | Value / Notes |
|---|---|
| `DATABASE_URL` | Supabase pooler port 6543 — runtime use |
| `DIRECT_URL` | Supabase direct port 5432 — `prisma db push` only |
| `ANTHROPIC_API_KEY` | Claude API key |
| `AI_MODEL` | `claude-haiku-4-5-20251001` — never hardcode in source |
| `AI_BASE_URL` | Anthropic base URL |
| `WHATSAPP_TOKEN` | Meta WhatsApp API token — **expires 2026-07-14** |
| `WHATSAPP_PHONE_ID` | Meta phone number ID |
| `WEBHOOK_VERIFY_TOKEN` | Meta webhook verification handshake token |
| `DEFAULT_COMPANY_ID` | Alex's company ID (`cmq4ok7hx000004kzfnsxp54o`) |
| `USE_DB_CATALOG` | `false` currently — switching to `true` is approved and safe |
| `ANTHROPIC_CREDIT_BALANCE_USD` | Update after each top-up (used for credit tracking) |
| `API_DAILY_SPEND_WARN_USD` | Daily spend threshold for warning notifications |
| `INTERNAL_API_KEY` | Attendance module internal auth key |
| `PORT` | HTTP port (defaults to 3001) |

### tutix-dashboard (Vercel)

| Variable | Notes |
|---|---|
| `NEXTAUTH_SECRET` | JWT signing secret |
| `NEXTAUTH_URL` | https://app.tutix.net |
| `DATABASE_URL` | Same Supabase as backend |
| `BACKEND_URL` | Railway backend URL |
| `JWT_SECRET` | Signs `tutix_session` cookie |

---

## Section 8: Current Production State

| Item | Status |
|---|---|
| PermanentCustomers | 607 real Alex records |
| Leads | 0 (cleaned, ready for re-import) |
| Conversations | 0 (cleaned, ready for real traffic) |
| AI Model | `claude-haiku-4-5-20251001` |
| WhatsApp Token | **Expires 2026-07-14 — needs renewal** |
| USE_DB_CATALOG | `false` on Railway (switching to `true` is approved) |
| Railway plan | Hobby ($10/month) |
| Anthropic balance | ~$11.45 remaining |
| Auto-reload | ON (Visa ending 7363) |
| DB catalog (Alex) | 9 Hajj programs + 31 Umrah programs + 10 hotels — verified |

### Alex's CompanyAIConfig — Verified DB State
- `hajjPrograms`: 9 programs (6 original + 3 added via `add-missing-hajj-programs.js`)
- `umrahPrograms`: 31 programs (July, August, September 2026)
- `hotelBookingLinks`: 10 hotels with booking URLs
- `industryData`: 4 branches, 10 hotels with details, 8 Hijri dates, installment contact
- `industryType`: `HAJJ_UMRAH`

---

## Section 9: Pending Tasks

### Ready to Do (approved, no blockers)
1. **Switch `USE_DB_CATALOG=true` on Railway** — local testing passed all checks. Set in Railway environment variables. The DB and builder are fully aligned.

### Requires Action
2. **Re-import Excel files** — leads + permanent customers. Files need to be uploaded via the admin import tool.
3. **WhatsApp token renewal before 2026-07-14** — go to Meta Business Manager → WhatsApp → Regenerate token before expiry.
4. **Business Verification on Meta** — required for profile photo, verified badge, and higher message volume limits.

### Requires Field Work
5. **Branch GPS coordinates** — collect accurate lat/lng for Alexandria, Cairo, and Port Said branches during next branch visits. Currently only Damietta has confirmed coordinates.
6. **Branch static IPs** — collect from branch routers to enable WiFi/IP verification for attendance (currently GPS-only).

### Business
7. **Alex subscription renewal** — next renewal: raise price to 18,000–20,000 EGP per 3 months.

---

## Section 10: Testing Rules

### Cost Per Test Type

| Test | API Calls | Estimated Cost |
|---|---|---|
| `node test-local.js` | 1–2 | ~$0.003 |
| Single `/webhook/test` via curl/PowerShell | 1–2 | ~$0.003 |
| `node qa-test.mjs` (full QA suite) | 31 | ~$0.10 |

### Rules
- **Max 5 test messages per session** unless explicitly needed for a specific feature test
- **Never run `qa-test.mjs` casually** — only for deliberate pre-release QA runs
- **Always stop the local server after testing** — `Ctrl+C` or `Stop-Process -Id <PID> -Force`
- Test phone numbers use unique timestamps (e.g. `20111<timestamp><suffix>`) to avoid polluting conversation history
- The `test-local.js` file has a **hardcoded message** — modify it or use PowerShell `Invoke-WebRequest` for different messages

### Starting Local Server with DB Catalog
```powershell
# Build first
npm run build

# Start with DB catalog enabled
$env:USE_DB_CATALOG = 'true'
node dist/src/main.js

# Or for dev mode (auto-recompile)
$env:USE_DB_CATALOG = 'true'
npm run start:dev
```

### Checking for Runaway Processes
```powershell
# See all node processes
tasklist /fi "imagename eq node.exe" /fo table

# See what each process is (command line)
Get-WmiObject Win32_Process -Filter "Name='node.exe'" | Select-Object ProcessId, CommandLine

# Kill by PID
Stop-Process -Id <PID> -Force
```

---

## Section 11: Key File Locations

### tutix-ai-crm (NestJS Backend)

| File | Purpose |
|---|---|
| `src/whatsapp/whatsapp.service.ts` | Main conversation loop, `applyHajjDateDisclaimer()`, `buildKnownFactsBlock()`, `getPrebuiltCatalog()` |
| `src/agent/agent.service.ts` | `getAgentReply()`, `extractLeadData()`, `calculateScore()`, `shouldHandoff()` |
| `src/agent/prompts/index.ts` | Static prompt entry point, `getIndustryPrompt()` |
| `src/agent/prompts/dynamic-catalog-builder.ts` | DB-path prompt builder, `buildIndustryPromptFromDB()` |
| `src/agent/prompts/base-personality.ts` | Core agent rules and guardrails |
| `src/agent/prompts/umrah-packages-2026.ts` | Umrah programs data + `buildUmrahCatalogTableFromData()` |
| `src/agent/prompts/hajj-packages.ts` | Static Hajj programs + `buildHajjCatalog()` |
| `src/agent/prompts/hajj-umrah-hotels.ts` | Hotel knowledge + `buildHotelKnowledgeFromData()` |
| `src/attendance/attendance.service.ts` | Check-in/out logic with GPS validation |
| `prisma/schema.prisma` | Database schema |
| `migrate-alex-ai-config.js` | One-time migration: created Alex's CompanyAIConfig |
| `add-missing-hajj-programs.js` | One-time migration: added 3 missing Hajj programs |
| `update-hajj-catalog-db.js` | Updates `cat.hajj` (flat format, not used by builder) |

### tutix-dashboard (Next.js Frontend)

| File | Purpose |
|---|---|
| `app/admin/` | Admin panel pages (companies, ai-config, faq-manager) |
| `app/api/admin/ai-config/route.ts` | CRUD for CompanyAIConfig list |
| `app/api/admin/ai-config/[id]/route.ts` | CRUD for single CompanyAIConfig |
| `app/api/companies/route.ts` | Company list (waToken excluded) — auth guarded |
| `app/api/companies/[id]/route.ts` | Company detail (waToken included) — auth guarded |
| `app/admin/_components/Sidebar.tsx` | Admin nav: شركات, إعدادات الذكاء الاصطناعي, إدارة الأسئلة |
| `lib/auth.ts` | `verifyToken()` for session cookie |
| `lib/prisma.ts` | Prisma client singleton |
| `prisma/schema.prisma` | Must stay in sync with backend schema |

---

## Section 12: Admin UI Design System

All admin pages use a consistent dark luxury design:

| Token | Value |
|---|---|
| Page background | `#0A0A0A` |
| Card background | `#141210` |
| Border | `#2a2420` |
| Gold accent | `#c9a84c` |
| Primary text | `#fefcf8` |
| Secondary text | `#6b6560` |
| Font | `Inter, system-ui, sans-serif` |

Auth guard pattern (copy exactly for new admin routes):
```typescript
function requireAdmin() {
  const token = cookies().get('tutix_session')?.value
  if (!token || !verifyToken(token)) return false
  return true
}
```

---

## Section 13: Common Commands

```bash
# Backend (tutix-ai-crm)
npm run start:dev          # Watch mode dev server
npm run build              # Compile TypeScript → dist/
npm run start:prod         # node dist/src/main.js
npx prisma generate        # Regenerate client after schema change
npx prisma db push         # Apply schema to DB (no migration history)
node test-local.js         # Single test message → localhost:3001
node qa-test.mjs           # Full QA suite (31 calls, ~$0.10)

# Frontend (tutix-dashboard)
npm run dev                # Next.js dev server (port 3000)
npm run build              # Production build
npx prisma generate        # Must run after any schema change here too
```

---

*Last updated: 2026-07-01. Generated from actual codebase state — not aspirational documentation.*
