import { ForbiddenException } from '@nestjs/common'
import { createHmac, timingSafeEqual } from 'crypto'

/** Constant-time string compare. Returns false on length mismatch rather than throwing. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

/**
 * Shared-secret guard for internal endpoints (same pattern as internal/cache-bust).
 *
 * FAIL-CLOSED: if the env var is unset the endpoint is disabled entirely — an
 * unconfigured secret must never mean "allow everyone". Throws ForbiddenException
 * on missing env var, missing header, or mismatch.
 */
export function assertInternalToken(provided: string | undefined, envVarName: string): void {
  const expected = process.env[envVarName]
  if (!expected) {
    console.warn(`[AUTH] ${envVarName} is not set — endpoint disabled (fail-closed)`)
    throw new ForbiddenException()
  }
  if (!provided || !safeEqual(provided, expected)) {
    throw new ForbiddenException()
  }
}

/**
 * Verifies Meta's X-Hub-Signature-256 HMAC over the RAW request body.
 *
 * The HMAC must be computed over the exact bytes Meta sent — a re-serialized
 * JSON object will not match, which is why main.ts enables rawBody.
 *
 * FAIL-CLOSED: no META_APP_SECRET, no raw body, or a malformed header all return
 * false. Without this, anyone who knows the URL can POST forged customer messages,
 * which makes the AI reply and send WhatsApp messages from the company's number.
 */
export function verifyMetaSignature(
  rawBody: Buffer | undefined,
  signatureHeader: string | undefined,
): { ok: boolean; reason?: string; unconfigured?: boolean } {
  const secret = process.env.META_APP_SECRET
  if (!secret)                            return { ok: false, unconfigured: true, reason: 'META_APP_SECRET not set' }
  if (!rawBody || rawBody.length === 0)   return { ok: false, reason: 'raw body unavailable' }
  if (!signatureHeader?.startsWith('sha256=')) return { ok: false, reason: 'missing or malformed X-Hub-Signature-256' }

  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex')
  return safeEqual(signatureHeader, expected)
    ? { ok: true }
    : { ok: false, reason: 'signature mismatch' }
}

// ── Rollout mode ─────────────────────────────────────────────────────────────
// The project is live. Signature verification ships in WARN mode: every request
// is verified and logged, but ACCEPTED regardless, so a wrong secret or a bad
// assumption about Meta's HMAC cannot cut off customer messages.
//
// Flip to enforcement only after the hourly [SIG_SUMMARY] line shows fail=0 over
// a representative period. See SECURITY.md → "Flipping to enforcement".
//
// Accepts true / "true" / 1 / yes with any quoting or casing — Railway stores
// flag vars as `"true"` with literal quotes.
function resolveFlag(raw: string | undefined): boolean {
  if (!raw) return false
  const n = raw.replace(/^["']|["']$/g, '').trim().toLowerCase()
  return n === 'true' || n === '1' || n === 'yes'
}

export function isSignatureEnforced(): boolean {
  return resolveFlag(process.env.META_SIGNATURE_ENFORCE)
}

const sigStats = { ok: 0, fail: 0, unconfigured: 0, since: new Date() }

/** Snapshot of signature outcomes since process start (resets on deploy/restart). */
export function getSignatureStats() {
  return { ...sigStats }
}

/** Single-line rollout summary for Railway logs. */
export function formatSignatureSummary(): string {
  const { ok, fail, unconfigured, since } = sigStats
  const total = ok + fail + unconfigured
  const mode  = isSignatureEnforced() ? 'ENFORCE' : 'WARN'
  const pct   = total > 0 ? `${((ok / total) * 100).toFixed(1)}%` : '—'
  const verdict = total === 0
    ? 'no inbound webhook traffic yet'
    : fail + unconfigured === 0
      ? 'all verified — safe to set META_SIGNATURE_ENFORCE=true'
      : `${fail + unconfigured} would be REJECTED under enforcement — do NOT flip yet`
  return `[SIG_SUMMARY] mode=${mode} since=${since.toISOString()} total=${total} ok=${ok} (${pct}) fail=${fail} unconfigured=${unconfigured} — ${verdict}`
}

export type SignatureDecision = {
  /** Whether the request should be processed. Always true in warn mode. */
  accept:   boolean
  /** Whether the signature actually verified. */
  verified: boolean
  enforced: boolean
  reason?:  string
}

/** Request details for the reject alarm. Every field is attacker-controlled — sanitise. */
export type SignatureContext = {
  /** Client IP, normally from x-forwarded-for (Railway sits behind a proxy). */
  ip?:          string
  /** Meta message type (text/image/…) pulled from the unverified body. */
  payloadType?: string
  /** Meta's top-level `object` field, e.g. whatsapp_business_account. */
  objectType?:  string
  bodyBytes?:   number
}

/**
 * Log-safe rendering of untrusted input.
 *
 * Strips CR/LF/control characters so a forged payload cannot inject a fake log
 * LINE, and strips square brackets so it cannot forge a bracketed marker either —
 * without that, a payload containing "[SIG] ok" would inflate a grep-based success
 * count even though it stayed on one line. Then truncates.
 */
function logSafe(v: unknown, max = 40): string {
  if (v === undefined || v === null || v === '') return '-'
  const s = String(v)
    .replace(/[\r\n\t]/g, ' ')
    .replace(/[\[\]]/g, '')          // no forged [MARKER]s
    .replace(/[^\x20-\x7E]/g, '')
    .trim()
  return s.length === 0 ? '-' : s.length > max ? s.slice(0, max) + '…' : s
}

/**
 * Verifies Meta's signature, records the outcome, logs it, and applies the
 * rollout policy.
 *
 * WARN mode (default):    always accept — logs [SIG] ok / FAIL / UNCONFIGURED.
 * ENFORCE mode:           reject anything that does not verify, including an
 *                         unset META_APP_SECRET (fail-closed), and additionally
 *                         emit [SIG_REJECT_ALARM] at ERROR level.
 *
 * The alarm fires ONLY under enforcement, because only then does a failure drop a
 * real customer message. In warn mode nothing is lost, so the [SIG] warn line is
 * enough and an alarm would be noise. Silent rejection is the failure mode that
 * actually costs customers, so the alarm carries the running fail count inline —
 * a spike is visible from a single log entry without correlating across lines.
 */
export function checkMetaSignature(
  rawBody: Buffer | undefined,
  signatureHeader: string | undefined,
  ctx: SignatureContext = {},
): SignatureDecision {
  const result   = verifyMetaSignature(rawBody, signatureHeader)
  const enforced = isSignatureEnforced()

  if (result.ok) {
    sigStats.ok++
    console.log('[SIG] ok')
    return { accept: true, verified: true, enforced }
  }

  if (result.unconfigured) sigStats.unconfigured++
  else                     sigStats.fail++

  const label    = result.unconfigured ? 'UNCONFIGURED' : 'FAIL'
  const disposition = enforced ? 'REJECTED' : 'accepted (warn mode — set META_SIGNATURE_ENFORCE=true to reject)'
  console.warn(`[SIG] ${label} — ${result.reason} → ${disposition}`)

  if (enforced) {
    const totalFailed = sigStats.fail + sigStats.unconfigured
    const seen        = sigStats.ok + totalFailed
    console.error(
      `[SIG_REJECT_ALARM] inbound webhook REJECTED — a customer message was DROPPED` +
      ` | reason=${logSafe(result.reason, 60)}` +
      ` | ip=${logSafe(ctx.ip)}` +
      ` | payloadType=${logSafe(ctx.payloadType, 24)}` +
      ` | object=${logSafe(ctx.objectType, 32)}` +
      ` | bodyBytes=${ctx.bodyBytes ?? 0}` +
      ` | sigHeader=${signatureHeader ? 'present' : 'MISSING'}` +
      ` | failCount=${totalFailed} of ${seen} since ${sigStats.since.toISOString()}` +
      ` | recovery: set META_SIGNATURE_ENFORCE=false on Railway (~30s restart, no rebuild)`,
    )
  }

  return { accept: !enforced, verified: false, enforced, reason: result.reason }
}
