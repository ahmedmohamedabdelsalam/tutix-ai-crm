# SECURITY — endpoint auth, deploy & rollback

Covers the webhook signature verification and internal-endpoint tokens.
**Read the rollback section before deploying** — the signature check is fail-closed.

---

## 1. Required environment variables

| Variable | Where | If unset |
|---|---|---|
| `META_APP_SECRET` | Railway (CRM) | Signature cannot be verified. In the shipped **warn mode** requests are still accepted and logged as `[SIG] UNCONFIGURED` — **no customer impact**. Under enforcement every inbound message would be rejected. Value: Meta App Dashboard → Settings → Basic → App Secret |
| `META_SIGNATURE_ENFORCE` | Railway (CRM) | **Warn mode (the shipped default): verify + log, accept everything.** Set to `true` only after §5 |
| `TEST_ENDPOINT_TOKEN` | Railway (CRM) **and** Vercel (dashboard) — same value | Test endpoints disabled; dashboard AI-resume and AI-takeover return 502 |
| `INTERNAL_CACHE_TOKEN` | Railway (CRM) **and** Vercel (dashboard) — same value | Catalog cache not busted; offering edits stale up to 5 min |
| `INTERNAL_API_KEY` | Railway (CRM) | `/attendance/*` disabled (401) |
| `WEBHOOK_VERIFY_TOKEN` | Railway (CRM) | Meta webhook subscription handshake fails |

Generate secrets with `openssl rand -hex 32`. Never commit them.

**Vercel bakes env vars at build time — redeploy after adding one, or the running build won't see it.**

### Deploy order

Signature verification ships in **warn mode**, so the CRM deploy is safe even if
`META_APP_SECRET` is missing or wrong — no customer message can be dropped.

1. Set `TEST_ENDPOINT_TOKEN` on Railway **and** Vercel (same value). This one *is*
   fail-closed, but it carries no customer traffic — only the gate suites and the
   dashboard's AI-resume / AI-takeover buttons.
2. Redeploy the dashboard (Vercel bakes env vars at build time).
3. Set `META_APP_SECRET` on Railway. If you miss this, warn mode logs
   `[SIG] UNCONFIGURED` and keeps accepting — you just cannot verify anything yet.
4. Push the CRM.
5. Run §3 verification, then follow §5 before enforcing.

Do **not** set `META_SIGNATURE_ENFORCE` during this deploy.

---

## 2. Rollback — inbound messages stopped after the push

**In warn mode this should be impossible** — the signature check cannot reject
anything. If messages stop while `META_SIGNATURE_ENFORCE` is unset, the cause is
elsewhere (check `WEBHOOK_DUP`, the unknown-`waPhoneId` warning, or Meta's own
delivery status) — do not chase the signature.

**Symptom:** customers send WhatsApp messages, nothing appears in the inbox.
**Confirm first** — Railway logs will show the cause:

```
[SIG] FAIL — … → REJECTED                    → enforcement is ON and rejecting, go to A
[SIG] UNCONFIGURED — … → REJECTED            → enforcement ON, secret missing,  go to A
[SIG] FAIL/UNCONFIGURED — … → accepted (warn) → NOT the cause; look elsewhere
(no [SIG] lines at all)                       → no inbound traffic reaching us
```

### A. Instant revert to warn mode (~30 s, no rebuild)

The fastest fix is always to turn enforcement **off**, not to roll back code:

1. Railway → service → **Variables** → set `META_SIGNATURE_ENFORCE=false`
   (or delete the variable entirely).
2. Railway restarts automatically on a variable change — no rebuild, no deploy.
3. Inbound messages resume immediately; verification keeps logging so you can
   diagnose with `[SIG]` lines while traffic flows normally.

Then fix the secret if that was the problem: `META_APP_SECRET` = Meta App Dashboard
→ Settings → Basic → *Show*. It is **not** the same value as `WEBHOOK_VERIFY_TOKEN`
(that one is only for the `GET /webhook` subscription handshake) — mixing those two
up is the likeliest error.

### B. Roll back the deployment

Last known-good CRM commit before signature verification: **`36ac1a1`**
(`fix(i18n+cache): Arabic number agreement helper …`).

**B1 — Railway dashboard (fastest, no rebuild):**
Railway → project → service → **Deployments** tab → the last deployment before this
change → **⋮** → **Redeploy**. Serves the previous image; inbound messages resume
within seconds.

**B2 — git revert (permanent, redeploys from source):**

```bash
git revert --no-edit <sha-of-signature-commit>
git push origin main          # Railway auto-deploys
```

Or hard-pin to the known-good tree:

```bash
git revert --no-edit <sha>..HEAD
git push origin main
```

**B3 — Railway CLI** (needs an interactive `railway login` first; the CLI is not
authenticated in CI):

```bash
railway login
railway status          # confirm the linked service
railway redeploy        # or use the dashboard for a specific past deployment
```

### After any rollback

Warn mode and a full code rollback both leave `POST /webhook` **effectively
unauthenticated** — anyone who knows the URL can inject forged customer messages,
which makes the AI reply and send WhatsApp from the company's number. Warn mode is a
staging step, not a destination: complete §5 and enforce.

---

## 3. Post-deploy verification

Run **both** probes. Probe A alone is not sufficient.

### Probe A — accept path, zero side effects

```bash
META_APP_SECRET=<same-value-as-railway> node test/gate/verify-webhook-signature.js
```

The script auto-detects the mode. In **warn mode** (the shipped default):

```
correctly signed        → 200  ✅ accepted
unsigned                → 200
wrong secret            → 200
tampered after signing  → 200

Detected mode: WARN
```

After the §5 flip:

```
correctly signed        → 200  ✅ accepted
unsigned                → 403
wrong secret            → 403
tampered after signing  → 403

Detected mode: ENFORCE
```

**In both modes, `correctly signed → 200` is the check that matters.** Anything else
there means real customer messages are being dropped.

Every probe carries a bogus `phone_number_id`, so an accepted request hits the
unknown-company guard and returns **before any DB write, AI call, or send**.

**What Probe A cannot tell you:** it signs with *our* implementation. It proves the
accept path, the `rawBody` plumbing and the secret are consistent with each other —
it cannot prove our HMAC matches Meta's, because Meta did not produce the signature.

### Probe B — genuine Meta signature (definitive)

Either:

1. **Meta App Dashboard** → WhatsApp → Configuration → Webhooks → **Test** the
   `messages` field. Meta sends a real, Meta-signed payload. Success = 200 in Meta's
   UI and **no** `WEBHOOK_SIG_REJECT` in Railway logs.

2. **Send one real WhatsApp message** from the test phone (`201091656041`) to the
   business number, then:

   ```bash
   node test/gate/verify-webhook-signature.js --check-inbound
   ```

   A `USER` row timestamped after you sent it = the Meta-signed request was accepted.
   Inbound persistence runs before the AI kill-switch check, so this works even with
   the agent paused — you get proof without the AI replying.

   No new row **and** `WEBHOOK_SIG_REJECT` in the logs = rejected → §2.

---

## 5. Flipping to enforcement

Warn mode leaves the hole open. Close it once the logs prove real Meta traffic verifies.

### Step 1 — watch the hourly summary

Once per hour the CRM logs one line in Railway:

```
[SIG_SUMMARY] mode=WARN since=2026-08-03T15:00:00.000Z total=1284 ok=1284 (100.0%) fail=0 unconfigured=0 — all verified — safe to set META_SIGNATURE_ENFORCE=true
```

Read it as:

| Field | Meaning |
|---|---|
| `total` | inbound webhook requests seen since the last restart |
| `ok` | signature verified — these would pass under enforcement |
| `fail` | signature invalid — **these would be rejected under enforcement** |
| `unconfigured` | `META_APP_SECRET` missing — also rejected under enforcement |
| `since` | counters are in-memory and reset on every deploy/restart |

Wait for a **representative** period — at least a full business day covering peak
hours, ideally 24h+ with no restart. `total` should be in the same ballpark as the
number of customer messages you actually received.

### Step 2 — decide

- `fail=0` **and** `unconfigured=0` **and** `total` looks realistic → safe to flip.
- Any `fail` > 0 → **do not flip.** Find the `[SIG] FAIL — <reason>` lines first.
  `signature mismatch` usually means the wrong App Secret; a burst from one source
  may be a genuine forgery attempt.
- `total=0` → no inbound traffic reached the service. Flipping proves nothing and
  risks everything. Investigate delivery before enforcing.

### Step 3 — flip

1. Railway → service → **Variables** → `META_SIGNATURE_ENFORCE=true`
2. Railway restarts automatically (~30 s, no rebuild). Confirm the startup line:
   `[STARTUP] META_SIGNATURE_ENFORCE raw="true" → ENFORCE (invalid signatures rejected)`
3. Immediately run §3 Probe A — it auto-detects the mode and should report `ENFORCE`.
4. Then §3 Probe B with a **real** WhatsApp message and confirm it still arrives.

### Step 4 — watch for 30 minutes

Tail Railway logs for `[SIG] FAIL … → REJECTED`. A rejected line that corresponds to
a real customer message means the flip was wrong.

**Instant revert:** set `META_SIGNATURE_ENFORCE=false` (or delete it). ~30 s, no
rebuild, no deploy, no git operation. This is why the flag exists — §2A.

---

## 4. Endpoint auth reference

| Endpoint | Auth | Notes |
|---|---|---|
| `POST /webhook` | `X-Hub-Signature-256` HMAC-SHA256 over raw body, constant-time | **Warn mode by default** — verified + logged, request still processed. Enforced only when `META_SIGNATURE_ENFORCE=true` (§5). Requires `rawBody: true` in `main.ts` |
| `GET /webhook` | `hub.verify_token` vs `WEBHOOK_VERIFY_TOKEN` | Meta subscription handshake |
| `POST /webhook/test` | `X-Internal-Token` vs `TEST_ENDPOINT_TOKEN` | Writes `Message` rows even with `simulate:true` |
| `POST /webhook/test-media` | `X-Internal-Token` vs `TEST_ENDPOINT_TOKEN` | Creates Lead + Conversation + 2 Messages |
| `POST /webhook/convreply` | `X-Internal-Token` vs `TEST_ENDPOINT_TOKEN` | Sends WhatsApp. Called by dashboard ai-takeover |
| `POST /webhook/test-followup` | `X-Internal-Token` vs `TEST_ENDPOINT_TOKEN` | Sends follow-ups to **real customers** |
| `POST /webhook/internal/cache-bust` | `X-Internal-Token` vs `INTERNAL_CACHE_TOKEN` | Called by dashboard offering writes |
| `/attendance/*` | `x-api-key` vs `INTERNAL_API_KEY` | 6 routes |
| `GET /health`, `GET /webhook/health` | none (public) | Liveness only, no data |

All **token** checks are fail-closed: an unset env var disables the endpoint rather
than allowing everyone. They carry no customer traffic, so enforcing immediately is
safe. The **Meta signature** is the exception — it gates live customer messages, so it
ships in warn mode and is enforced deliberately via §5. Comparisons are constant-time
(`crypto.timingSafeEqual`).

### Known gaps (not yet addressed)

- `app.enableCors()` takes no options → **wildcard CORS**. Any site can invoke these
  endpoints from a visitor's browser; only the tokens stop them.
- Untracked root-level scratch scripts (`simulate-tests.js`, `_adv_rerun.js`, …) call
  `/webhook/test` and now receive 403 until they send `X-Internal-Token`.
- The `[SIMULATE]` log line in `whatsapp.controller.ts` still claims replies are "not
  persisted to DB". They are — `persistReply` has no simulate branch.
