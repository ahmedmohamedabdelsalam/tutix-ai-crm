# Confidence Gate Suite

End-to-end verification suite for the confidence layer (Routes 1–4) of the Tutix AI CRM.

## What it tests

| Section | Description |
|---|---|
| A | **20-Question gate** — 20 representative customer messages; every handler must return the correct deterministic reply. Gate v3 baseline: 20/20 PASS. |
| B | **10 Adversarial questions** — blocked categories (visa, refund, discount, etc.) and consecutive-no-match repeat_failure. |
| C | **FAQ route** — live FAQ entry injected into DB before server start; verified cached correctly; cache cleared on server restart. |
| D | **Output guard** — forces AI to emit a digit; confirms guard blocks it and routes to handoff; HandoffLog row verified. |
| E | **Working-hours template** — pure offline function test; injected timestamps cover inside/outside/boundary cases. |

## Prerequisites

```bash
npm run build        # must be done before running the suite
```

Env vars required: `DATABASE_URL`, `DIRECT_URL`, `DEFAULT_COMPANY_ID`, `PORT` (default 3001).

## Run

```bash
node test/gate/confidence-suite.js
```

From the repo root. The suite spawns a local server, runs all sections, and reports a final summary.

## Safety invariants

- `simulate=true` throughout — zero WhatsApp messages sent.
- Test phone `201091656041` only — never real customer numbers.
- No writes to `isActive`, `agentMode`, or any env var.
- All conversations stamped `isTest=true` by the `/webhook/test` controller.

## Companion test

`_hotel_guard_test.js` (repo root) tests the hotel-content handler and entity-blocklist output guard independently. Run separately:

```bash
node _hotel_guard_test.js
```

## Pre-push build guard

A `.githooks/pre-push` hook is committed in the repo. Run `npm install` once to activate it:

```bash
npm install   # sets core.hooksPath=.githooks via the prepare script
```

After activation every `git push` automatically:
1. Blocks the push if any `.ts` files in `src/` are untracked (exist locally but not staged — the pattern that caused 4 consecutive Railway build failures when new files were created locally before being committed).
2. Runs `npm run build` to catch TypeScript errors.

For a full clean-checkout simulation (clears the incremental tsbuildinfo cache before building):

```bash
npm run build:clean
```

Run this before pushing whenever you add a new `.ts` file to `src/` to match what Railway sees on a cold build.
