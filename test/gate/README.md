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

---

## verify-webhook-signature.js — post-deploy signature check

`POST /webhook` verifies Meta's `X-Hub-Signature-256`. It ships in **warn mode**
(`META_SIGNATURE_ENFORCE` unset): the outcome is logged as `[SIG] ok` / `[SIG] FAIL`,
but every request is still processed, so a wrong secret cannot cut off live customer
traffic. Enforcement is opt-in — see [SECURITY.md](../../SECURITY.md) §5.

Run immediately after any deploy that touches signature verification, `META_APP_SECRET`,
or `META_SIGNATURE_ENFORCE`:

```bash
META_APP_SECRET=<same-value-as-railway> node test/gate/verify-webhook-signature.js
```

It proves correctly-signed requests are **accepted** (not just that forgeries are
rejected) and reports the detected mode, with zero side effects — the probes use a bogus
`phone_number_id`, so they stop at the unknown-company guard before any DB write, AI
call, or WhatsApp send. `correctly signed → 200` must hold in both modes.

The CRM also logs one `[SIG_SUMMARY]` line per hour showing how many inbound requests
passed vs failed verification — that is the signal for when it is safe to enforce.

That probe signs with our own implementation, so it cannot prove our HMAC matches Meta's.
Follow it with a genuine Meta-signed request:

```bash
# after sending one real WhatsApp message from the test phone to the business number
node test/gate/verify-webhook-signature.js --check-inbound
```

Rollback steps, deploy order, and the full endpoint auth table are in [SECURITY.md](../../SECURITY.md).

### Test-endpoint token

The gate suites call `/webhook/test`, which now requires `X-Internal-Token`. They read
`TEST_ENDPOINT_TOKEN` from the environment; when it is unset they mint an ephemeral token
and inject it into the server they spawn, so local runs need no configuration. The token
is never hardcoded.
