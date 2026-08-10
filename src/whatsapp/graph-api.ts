/**
 * The Graph API version, in ONE place, overridable without a deploy.
 *
 * WHY THIS EXISTS: the version was hardcoded at five call sites across two repos —
 * three here, two in tutix-dashboard — and every one of them said v18.0.
 *
 * v18.0 was released 12 Sep 2023 and EXPIRED on 26 Jan 2026. Meta's documented
 * behaviour for an expired version is that "any calls made to it will be defaulted
 * to the next oldest, usable version", so since January every outbound call has
 * been silently served by a version we did not choose and cannot name. Nothing
 * broke, which is exactly why nobody noticed. A pin that no longer pins anything is
 * worse than no pin: it reads as deliberate.
 *
 * v25.0 runs to 29 Jul 2028 and postdates the July 2026 launch of BSUID-targeted
 * sending, so it is the oldest version certain to accept the `recipient` parameter
 * that Phase 3 needs.
 *
 * ENV-DRIVEN ON PURPOSE. If a bump breaks media upload or download in production —
 * the most version-sensitive surface and the least covered by tests — the fix is an
 * env var and a restart, not a revert, a rebuild and a deploy.
 */

const DEFAULT_GRAPH_VERSION = 'v25.0'

function resolveVersion(raw: string | undefined): string {
  if (!raw) return DEFAULT_GRAPH_VERSION
  // Railway stores flag vars with literal quotes; strip them the same way the
  // feature flags do, then require the exact vNN.N shape. A malformed value would
  // otherwise produce a 404 on every send, which looks nothing like a config error.
  const v = raw.replace(/^["']|["']$/g, '').trim()
  if (!/^v\d+\.\d+$/.test(v)) {
    console.warn(`[STARTUP] GRAPH_API_VERSION="${raw}" is malformed — falling back to ${DEFAULT_GRAPH_VERSION}`)
    return DEFAULT_GRAPH_VERSION
  }
  return v
}

export const GRAPH_VERSION = resolveVersion(process.env.GRAPH_API_VERSION)
export const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`

console.log(
  `[STARTUP] GRAPH_API_VERSION raw="${process.env.GRAPH_API_VERSION ?? ''}" → ${GRAPH_VERSION}` +
  `${GRAPH_VERSION === DEFAULT_GRAPH_VERSION ? ' (default)' : ' (override)'}`,
)
