import type { PrismaService } from '../prisma/prisma.service'
import { ConvStatus } from '@prisma/client'

/**
 * Who an inbound message is from — Phase 3b.
 *
 * Phone used to BE the identity. Meta's usernames rollout ends that: once a user
 * adopts a username, `from`/`wa_id` are omitted and only contacts[0].user_id
 * arrives. So identity is now a pair, either half of which may be absent, and
 * resolution prefers the stable half.
 *
 * THE DANGEROUS SHAPE THIS EXISTS TO PREVENT: `findFirst({ companyId, phone })`
 * with a null phone matches ANY null-phone conversation in that company — it would
 * hand one customer another customer's thread, silently, on their first message.
 * Every lookup below is therefore guarded on the key being non-null. That is the
 * whole reason this is a module and not three inline queries.
 */
export interface InboundIdentity {
  /** wa_id / message.from. Null once the user adopts a username. */
  phone: string | null
  /** Business-scoped user ID, "<CC>.<alnum>". Null until Meta sends one. */
  waUserId: string | null
  /**
   * WhatsApp display name — DISPLAY ONLY, never used to resolve anyone. The
   * customer sets it and can change it whenever they like, so it identifies
   * nothing; it exists so a phone-less thread is not an anonymous row.
   */
  profileName?: string | null
}

/**
 * contacts[0].profile.name, trimmed and capped.
 *
 * Untrusted, customer-controlled text that will be rendered in the sales inbox, so
 * control characters are stripped here rather than at each display site. The cap is
 * generous but finite: a name is not a place to accept unbounded input.
 */
export function extractProfileName(value: unknown): string | null {
  const contact = (value as { contacts?: Array<{ profile?: { name?: unknown } }> } | undefined)?.contacts?.[0]
  const raw = contact?.profile?.name
  if (typeof raw !== 'string') return null
  const name = raw.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 120)
  return name.length ? name : null
}

export function hasIdentity(id: InboundIdentity): boolean {
  return !!id.phone || !!id.waUserId
}

/** Safe for logs: the BSUID is shaped, the phone is already logged elsewhere. */
export function describeIdentity(id: InboundIdentity): string {
  const b = id.waUserId ? `bsuid=${id.waUserId.split('.')[0]}.…(${id.waUserId.length})` : 'bsuid=none'
  return `phone=${id.phone ?? 'none'} ${b}`
}

/**
 * Find this customer's open conversation.
 *
 * waUserId FIRST, because it is the identifier that survives: a customer who
 * adopts a username keeps their BSUID and loses their phone, so matching on phone
 * first would create a second conversation for someone we can already recognise.
 * Phone remains the fallback for everyone Meta has not sent a BSUID for.
 */
export async function findConversation(
  prisma: PrismaService,
  companyId: string,
  identity: InboundIdentity,
  include: object,
) {
  if (identity.waUserId) {
    const byBsuid = await prisma.conversation.findFirst({
      where: { companyId, waUserId: identity.waUserId, status: { not: ConvStatus.CLOSED } },
      include, orderBy: { updatedAt: 'desc' },
    })
    if (byBsuid) return byBsuid
  }
  // Guarded: a null phone must never be used as a search key.
  if (identity.phone) {
    return prisma.conversation.findFirst({
      where: { companyId, phone: identity.phone, status: { not: ConvStatus.CLOSED } },
      include, orderBy: { updatedAt: 'desc' },
    })
  }
  return null
}

/**
 * The canonical Lead for this customer, or null when there cannot be one.
 *
 * Lead carries no waUserId, so a BSUID-only customer has nothing to match on and
 * MUST get a fresh lead. Returning null here is correct; matching on a null phone
 * would attach them to a stranger's lead.
 */
export async function findLead(
  prisma: PrismaService,
  companyId: string,
  identity: InboundIdentity,
) {
  if (!identity.phone) return null
  return prisma.lead.findFirst({
    where: { companyId, phone: identity.phone },
    orderBy: { createdAt: 'asc' },
  })
}
