/**
 * How to ADDRESS an outbound WhatsApp message — Phase 3c.
 *
 * Meta accepts two addressing fields on /messages:
 *   to        a phone number
 *   recipient a business-scoped user ID ("<CC>.<alnum>")
 * When both are supplied `to` takes precedence, so we send exactly one.
 *
 * Phone is preferred when we have it: it is the addressing every existing
 * conversation already uses and the one with years of delivery behind it.
 * `recipient` is for the customers who no longer have a phone we can see — before
 * 3c those customers were visible in the inbox and impossible to answer.
 *
 * VERIFIED, PARTLY: on v25.0, supplying `recipient` changes Meta's error from
 * "The parameter to is required" to "(#100) Invalid parameter" — proving the
 * parameter is RECOGNISED and accepted as the addressee. Delivery to a real BSUID
 * is a separate claim and is proven by an end-to-end send, not by this file.
 */

export interface SendTarget {
  phone: string | null
  waUserId: string | null
}

export type AddressingMode = 'to' | 'recipient' | 'none'

export function addressingMode(t: SendTarget): AddressingMode {
  if (t.phone) return 'to'
  if (t.waUserId) return 'recipient'
  return 'none'
}

/**
 * The addressing fields for a Meta message body, or null when this target cannot
 * be addressed at all. Callers must treat null as a hard failure and say so —
 * never as "send anyway".
 */
export function addressingFields(t: SendTarget): { to: string } | { recipient: string } | null {
  if (t.phone) return { to: t.phone }
  if (t.waUserId) return { recipient: t.waUserId }
  return null
}

/** Safe for logs: shapes the BSUID, leaves the phone as-is (already logged elsewhere). */
export function describeTarget(t: SendTarget): string {
  const mode = addressingMode(t)
  if (mode === 'to') return `to=${t.phone}`
  if (mode === 'recipient') return `recipient=${(t.waUserId ?? '').split('.')[0]}.…(${(t.waUserId ?? '').length})`
  return 'UNADDRESSABLE'
}
