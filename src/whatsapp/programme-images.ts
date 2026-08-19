import { createHash } from 'crypto'
import { toOutboundImage, type OutboundImage } from './reply-shape'

/**
 * Which programme image, if any, may be sent with a reply — Stage 2.
 *
 * An image with a printed price is a fact no guard can inspect. scanModelOutput
 * reads text for digits, months and hotel names; against a JPEG it is blind. If the
 * price changed after the image was made, sending it quotes the customer a number
 * that is simply wrong — and a picture is more convincing than a message and can be
 * screenshotted in a dispute.
 *
 * So this is FAIL-CLOSED in every direction. A stale fingerprint, a missing
 * descriptor, an unreadable value, no cached fingerprint to compare against — every
 * one of them returns null and the reply goes out as text alone. Text is always
 * correct because it is generated from live data at send time; the image is the only
 * part that can be out of date, so the image is the only part we drop.
 */

export interface ProgrammeImage {
  url: string
  path: string
  mime: string
  bytes: number
  checksum: string
  priceBearing: boolean
  priceFingerprint: string
}

/**
 * The price fingerprint, reimplemented here from its documented algorithm rather
 * than imported from the dashboard.
 *
 * The two repos cannot share code, and the value is written on one side and
 * enforced on the other — so restating the algorithm means a silent change to it
 * surfaces as a blocked image rather than as the two halves quietly agreeing to
 * send a stale price. Canonical form: price-role keys sorted, values trimmed to
 * strings, JSON-encoded, sha256 hex.
 */
export function priceFingerprint(
  values: Record<string, unknown>,
  fieldDefs: Array<{ key: string; role: string | null }>,
): string {
  const keys = fieldDefs.filter(f => f.role?.startsWith('price')).map(f => f.key).sort()
  if (keys.length === 0) return ''
  const canonical = keys.map(k => {
    const v = values[k]
    return [k, v === null || v === undefined ? '' : String(v).trim()] as const
  })
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

/**
 * ── BOUNDARY: THE AGENT READS OFFERING IMAGES ONLY ───────────────────────────
 *
 * Sales reps have a PERSONAL image library (dashboard: LibraryImage, surfaced in
 * the composer). It is deliberately NOT reachable from here, and wiring it in later
 * would be a mistake rather than a feature.
 *
 * The reason is the guard directly below this comment. An offering image carries a
 * price fingerprint, so `chooseProgrammeImage` can refuse it the moment the prices
 * move. A personal image has no offering, therefore no fingerprint, therefore
 * nothing to compare — the agent would be sending a picture with a price on it and
 * no way to know whether that price is still true.
 *
 * That is survivable when a human presses send: the rep chose the picture, can see
 * what is on it, and owns the claim. It is not survivable unattended, at whatever
 * hour a customer happens to write, with nobody looking at what goes out.
 *
 * If personal images ever need to reach customers automatically, they need a
 * fingerprint first — not a shortcut through this function.
 */

/** Descriptors off an Offering value, ignoring anything malformed. */
export function readProgrammeImages(raw: unknown): ProgrammeImage[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((x): x is ProgrammeImage =>
    !!x && typeof x === 'object'
    && typeof (x as ProgrammeImage).url === 'string'
    && typeof (x as ProgrammeImage).checksum === 'string')
}

export type ImageDecision =
  | { send: ProgrammeImage }
  | { blocked: 'stale' | 'no_images' | 'no_fingerprint' }

/**
 * Pick a sendable image for one programme.
 *
 * `currentFingerprint` is the programme's price fingerprint as of THIS catalog
 * build — not as of upload. A mismatch means a price moved since the picture was
 * made, which is exactly the case that must never reach a customer.
 */
export function chooseProgrammeImage(
  images: ProgrammeImage[],
  currentFingerprint: string,
): ImageDecision {
  if (!images.length) return { blocked: 'no_images' }

  for (const img of images) {
    // Not price-bearing: nothing on it can go stale, so it is always sendable.
    if (!img.priceBearing) return { send: img }
    // Price-bearing with nothing to compare against is a doubt, and doubt loses.
    if (!img.priceFingerprint || !currentFingerprint) continue
    if (img.priceFingerprint === currentFingerprint) return { send: img }
  }

  // Something exists but none of it is safe. Distinguish the reasons so the log
  // says whether a price moved or a fingerprint was never recorded.
  const anyPriceBearing = images.some(i => i.priceBearing)
  if (!anyPriceBearing) return { blocked: 'no_images' }
  const anyComparable = images.some(i => i.priceBearing && i.priceFingerprint && currentFingerprint)
  return { blocked: anyComparable ? 'stale' : 'no_fingerprint' }
}

interface ProgrammeLike { name?: string; images?: unknown; priceFingerprintNow?: string }

/**
 * The programme this reply is unambiguously about, or null.
 *
 * An umrah "trip" is a departure/return pair that can bundle several levels —
 * economy and deluxe at different prices — and its detail text lists all of them.
 * One picture cannot honestly caption several prices, and the customer would read
 * the pictured one as the price. So a multi-programme reply gets no image at all:
 * this is the "never in chunk mode" rule applied to the other way a reply can cover
 * more than one programme.
 */
export function resolveSingleProgramme(x: unknown): ProgrammeLike | null {
  if (!x || typeof x !== 'object') return null
  const progs = (x as { progs?: unknown }).progs
  if (Array.isArray(progs)) {
    return progs.length === 1 && progs[0] && typeof progs[0] === 'object'
      ? progs[0] as ProgrammeLike
      : null
  }
  return x as ProgrammeLike
}

/**
 * The one entry point a reply handler calls: "may I attach a picture to this?"
 *
 * Returns an array so the caller can spread it unconditionally — the empty case is
 * the normal case and needs no branch at the call site. Every refusal is logged
 * with the reason, loudly for a stale price because that one means a customer
 * nearly received a wrong number in a form no text guard could have caught.
 */
export function attachmentFor(prog: unknown, detailText: string, ctx: string): OutboundImage[] {
  const p = resolveSingleProgramme(prog)
  if (!p) return []

  const images = readProgrammeImages(p.images)
  const decision = chooseProgrammeImage(images, p.priceFingerprintNow ?? '')

  if ('blocked' in decision) {
    // no_images is the ordinary state of a programme nobody has uploaded a picture
    // for. Logging it at error level every reply would bury the two that matter.
    if (decision.blocked !== 'no_images') {
      console.error(
        `[IMAGE_STALE_BLOCKED] ${ctx} programme="${p.name ?? '?'}" reason=${decision.blocked} — ` +
        'the image was NOT sent because it may show a price that no longer applies. ' +
        'The text reply was sent and is correct. Re-upload the image to restore it.',
      )
    }
    return []
  }
  return [toOutboundImage(decision.send, captionFor(detailText))]
}

/**
 * The caption: the programme's headline, which is the first line of the detail text.
 *
 * Deliberately NOT a second copy of the prices. The caption rides on the image and
 * cannot be regenerated later, so it carries only the name; every figure stays in
 * the text message below, which is rebuilt from live data every time it is sent.
 */
export function captionFor(detailText: string): string {
  const firstLine = detailText.split('\n').find(l => l.trim().length > 0) ?? ''
  // Strip the price clause after the em-dash so the caption cannot outlive a change.
  const withoutPrice = firstLine.split('—')[0]
  return withoutPrice.replace(/[*_]/g, '').trim().slice(0, 120)
}
