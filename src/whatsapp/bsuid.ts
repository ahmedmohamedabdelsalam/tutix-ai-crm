import type { PrismaService } from '../prisma/prisma.service'

/**
 * Business-scoped user ID (BSUID) capture — Phase 1.
 *
 * Meta's usernames rollout replaces the phone number as the identifier: once a user
 * adopts a username, `from` and `wa_id` are omitted and identity arrives only as
 * contacts[0].user_id, formatted "<CC>.<alnum>" (e.g. EG.13491208655302741918).
 *
 * WHY CAPTURE BEFORE WE CAN USE IT: during the transition Meta sends BOTH
 * identifiers for a conversation that already has a phone. That overlap is the only
 * window in which an existing phone-keyed row can be linked to the same person's
 * BSUID. Once a user's phone stops being sent, a returning customer looks like a
 * brand-new one and their history is orphaned — permanently, because nothing
 * afterwards ever ties the two together again.
 *
 * So this stores the ID now and changes no behaviour. Identity resolution still runs
 * on phone; switching to BSUID-first, and making phone optional, is Phase 3.
 */

/** contacts[0].user_id if it is present and well-formed, else null. */
export function extractBsuid(value: unknown): string | null {
  const contact = (value as { contacts?: Array<Record<string, unknown>> } | undefined)?.contacts?.[0]
  const raw = contact?.user_id
  if (typeof raw !== 'string') return null
  const id = raw.trim()
  // "<CC>.<up to 128 alnum>" — anything else is not something we should store as an
  // identity, and a unique index makes a malformed value expensive to undo.
  if (!/^[A-Za-z]{2}\.[A-Za-z0-9]{1,128}$/.test(id)) return null
  return id
}

/**
 * Attach a BSUID to a conversation that does not have one yet.
 *
 * Deliberately never OVERWRITES: a conversation's BSUID is stable, so a differing
 * value means either a Meta change or our own mistake, and silently replacing an
 * identity is how two customers become one. It logs and leaves the stored value
 * alone instead.
 *
 * Fire-and-forget by design — this is observability plumbing on the message hot
 * path, and it must never delay or fail a customer's reply. The unique index on
 * (companyId, waUserId) is the real guarantee; a lost write here is retried on the
 * customer's next message.
 */
export async function linkBsuid(
  prisma: PrismaService,
  conversationId: string,
  bsuid: string | null,
  ctx: { phone?: string } = {},
): Promise<void> {
  if (!bsuid) return
  try {
    const conv = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { waUserId: true },
    })
    if (!conv) return
    if (conv.waUserId === bsuid) return
    if (conv.waUserId) {
      console.warn(
        `[BSUID_CONFLICT] conversation=${conversationId} already has a different user_id — keeping the stored one. ` +
        `This should not happen; a BSUID is stable per (business, user).`,
      )
      return
    }
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { waUserId: bsuid },
    })
    console.log(
      `[BSUID_LINKED] conversation=${conversationId}${ctx.phone ? ` phone=${ctx.phone}` : ''} ` +
      `— phone-keyed row now carries its BSUID, so this customer survives losing their phone number`,
    )
  } catch (err: unknown) {
    // A duplicate here means the same BSUID is already on another conversation for
    // this company — two rows for one person, which Phase 3 has to merge. Worth
    // knowing about; not worth failing a customer reply over.
    const code = (err as { code?: string })?.code
    if (code === 'P2002') {
      console.warn(`[BSUID_DUPLICATE] user_id already linked to a different conversation in this company — merge needed at Phase 3`)
      return
    }
    console.error('[BSUID_LINK_FAILED]', err)
  }
}
