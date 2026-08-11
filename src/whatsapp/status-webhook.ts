import { PrismaService } from '../prisma/prisma.service'

/**
 * Meta's delivery statuses — captured, ranked, and never allowed to go backwards.
 *
 * Meta posts `value.statuses[]` on the same webhook as inbound messages, and we have
 * been dropping them entirely. The cost is not just missing ticks: a `failed` status
 * is a customer who never received what we sent, and today nothing anywhere records
 * that. A rep sees the message in the thread and assumes it landed.
 */

export interface MetaStatus {
  id?: string                 // the wamid of the OUTBOUND message this refers to
  status?: string             // sent | delivered | read | failed (Meta may add more)
  timestamp?: string          // unix seconds, as a string
  errors?: Array<{ code?: number; title?: string; message?: string; error_data?: { details?: string } }>
}

/**
 * Rank decides what may overwrite what. Statuses arrive out of order — Meta retries,
 * and a redelivered `delivered` can land after a `read` — so the rule is FORWARD-ONLY:
 * a status is written only if it outranks what is already there.
 *
 *   sent(1) → failed(2) → delivered(3) → read(4)
 *
 * `failed` sits above `sent` because a message that failed was, before that, merely
 * sent — failure is the newer truth. It sits BELOW delivered and read because those
 * are positive proof the message arrived, and a late `failed` contradicting them
 * would be Meta contradicting itself; the evidence of arrival wins.
 *
 * An unknown status ranks 0 and can never overwrite anything, so a value Meta adds
 * later is recorded in the log without corrupting a known-good state.
 */
const RANK: Record<string, number> = { sent: 1, failed: 2, delivered: 3, read: 4 }

export function statusRank(status: string | null | undefined): number {
  if (!status) return 0
  return RANK[status.toLowerCase()] ?? 0
}

/** True when `next` is allowed to replace `current`. */
export function advances(current: string | null | undefined, next: string | null | undefined): boolean {
  const n = statusRank(next)
  if (n === 0) return false          // unknown status never overwrites
  return n > statusRank(current)
}

/** Meta's error shape flattened into one line a human can act on. */
export function describeFailure(s: MetaStatus): string {
  const e = s.errors?.[0]
  if (!e) return 'Meta reported failure with no error detail'
  const parts = [
    e.code !== undefined ? `(#${e.code})` : '',
    e.title ?? '',
    e.error_data?.details ?? e.message ?? '',
  ].filter(Boolean)
  return parts.join(' ').trim().slice(0, 500)
}

function toDate(ts: string | undefined): Date {
  const n = Number(ts)
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : new Date()
}

export interface StatusOutcome {
  applied: number
  ignored: number   // arrived but did not outrank what was stored
  orphans: number   // no message row carries that wamid
}

/**
 * Apply a batch of statuses.
 *
 * NEVER THROWS. Meta retries a webhook that errors, so an exception here would turn
 * one bad status into a retry storm that also delays real inbound messages. Every
 * failure is logged and swallowed; the caller has already returned 200 regardless.
 *
 * ORPHANS ARE THE MEASUREMENT. A status whose wamid matches no row is proof that an
 * outbound message was sent but never stamped — measured from the direction that
 * matters, and it accumulates from the moment this ships rather than waiting for a
 * sample to build. If stamping coverage is right, this number stays near zero.
 */
export async function applyStatuses(
  prisma: PrismaService,
  companyId: string,
  statuses: MetaStatus[],
): Promise<StatusOutcome> {
  const out: StatusOutcome = { applied: 0, ignored: 0, orphans: 0 }

  for (const s of statuses ?? []) {
    try {
      const wamid = s?.id
      const status = s?.status?.toLowerCase()
      if (!wamid || !status) continue

      // Scoped by company: a wamid is Meta's, not ours, and an unscoped lookup is the
      // same widening class fixed in query-guard.ts.
      const row = await prisma.message.findFirst({
        where: { whatsappMsgId: wamid, conversation: { companyId } },
        select: { id: true, status: true },
      })

      if (!row) {
        out.orphans++
        console.warn(
          `[STATUS_ORPHAN] status=${status} wamid=${wamid} company=${companyId} — ` +
          'no message row carries this wamid, so an outbound message was sent but never ' +
          'stamped. This message can never show a delivery state.',
        )
        continue
      }

      if (!advances(row.status, status)) {
        out.ignored++
        if (statusRank(status) === 0) {
          console.log(`[STATUS_UNKNOWN] "${status}" wamid=${wamid} — recorded in the log only, nothing overwritten`)
        }
        continue
      }

      await prisma.message.update({
        where: { id: row.id },
        data: {
          status,
          statusAt: toDate(s.timestamp),
          // Only ever set on failure, and cleared if a later status proves arrival.
          failureReason: status === 'failed' ? describeFailure(s) : null,
        },
      })
      out.applied++

      if (status === 'failed') {
        console.error(
          `[STATUS_FAILED] wamid=${wamid} message=${row.id} — the customer did NOT receive this. ` +
          `Meta said: ${describeFailure(s)}`,
        )
      }
    } catch (err) {
      // One bad status must not take the batch — or the webhook — down.
      console.error(`[STATUS_APPLY_FAILED] wamid=${s?.id ?? '?'} — ${(err as Error)?.message}`)
    }
  }

  if (out.applied || out.ignored || out.orphans) {
    console.log(`[STATUS_BATCH] applied=${out.applied} ignored=${out.ignored} orphans=${out.orphans}`)
  }
  return out
}
