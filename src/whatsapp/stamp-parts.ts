import { PrismaService } from '../prisma/prisma.service'

/**
 * Pair persisted rows with the wamids of the messages they ARE, and stamp them.
 *
 * Both arrays come from splitting the same text with the same splitIntoMessages —
 * `saveAssistantMessage` returns one row id per part, `sendWhatsAppMessage` returns
 * one wamid per part — so row[i] and wamid[i] are the same message. This is a pairing
 * by construction, not a match by heuristic, which is the whole point: the previous
 * approach re-queried "recent ASSISTANT rows with no wamid" and zipped positionally,
 * and a single stale unstamped row from an earlier turn shifted every pairing after it.
 *
 * FAIL-CLOSED on any disagreement in length. A wrong stamp puts a read receipt on a
 * message the customer never saw — a confident false statement a rep will act on.
 * No stamp is an honest silence, so when the counts disagree, nothing is written.
 */
export async function stampParts(
  prisma: PrismaService,
  rowIds: string[] | undefined,
  wamids: (string | null)[],
  ctx: string,
): Promise<number> {
  if (!rowIds || rowIds.length !== wamids.length) {
    console.error(
      `[WAMID_STAMP_SKIPPED] ${ctx}: ${rowIds ? rowIds.length : 'no'} persisted row(s) ` +
      `vs ${wamids.length} sent part(s). Refusing to guess the pairing — these messages ` +
      'will have no delivery status.',
    )
    return 0
  }
  let stamped = 0
  for (let i = 0; i < rowIds.length; i++) {
    const w = wamids[i]
    if (!w) continue   // that part failed to send; leaving the row unstamped is correct
    try {
      await prisma.message.update({ where: { id: rowIds[i] }, data: { whatsappMsgId: w } })
      stamped++
    } catch (err: unknown) {
      // P2002 means this wamid is already on another row — which can only happen if
      // the pairing is wrong. Loud, because nothing else would ever notice.
      const code = (err as { code?: string })?.code
      console.error(
        code === 'P2002'
          ? `[WAMID_STAMP_COLLISION] ${ctx}: wamid ${w} is already stamped on another row — pairing is wrong`
          : `[WAMID_STAMP_FAILED] ${ctx}: row=${rowIds[i]} — ${(err as Error)?.message}`,
      )
    }
  }
  return stamped
}
