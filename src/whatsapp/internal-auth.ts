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

/**
 * Verifies Meta's signature, records the outcome, logs it, and applies the
 * rollout policy.
 *
 * WARN mode (default):    always accept — logs [SIG] ok / FAIL / UNCONFIGURED.
 * ENFORCE mode:           reject anything that does not verify, including an
 *                         unset META_APP_SECRET (fail-closed).
 */
export function checkMetaSignature(
  rawBody: Buffer | undefined,
  signatureHeader: string | undefined,
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

  return { accept: !enforced, verified: false, enforced, reason: result.reason }
}
