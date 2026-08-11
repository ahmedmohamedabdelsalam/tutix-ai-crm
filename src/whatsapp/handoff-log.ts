import { PrismaService } from '../prisma/prisma.service'

export type HandoffReason = 'no_handler' | 'blocked_category' | 'output_guard' | 'repeat_failure' | 'freshness_gate'

/**
 * AWAITED, unlike the other background writes in this service.
 *
 * A HandoffLog row is the only signal sales ever get that a customer needs a human.
 * Lose it and nobody is told — the customer simply waits, and no error appears
 * anywhere because the failure is in a promise nobody is holding. That outranks the
 * cost of a few milliseconds on the reply path.
 *
 * The other fire-and-forget writes here stay as they are: this is a long-running
 * NestJS process, not a serverless function, so its event loop keeps running after a
 * response and those promises do complete. The only loss window is a deploy or crash
 * mid-flight — real but rare, and not worth the latency everywhere. A missed handoff
 * is the one case where that trade lands on the wrong side.
 *
 * Still never throws: the catch is kept so a logging failure cannot take down the
 * customer's reply, but it LOGS rather than swallowing.
 */
export async function logHandoff(
  prisma: PrismaService,
  args: {
    companyId:       string
    conversationId:  string
    /// Nullable since Phase 3a: a BSUID-only conversation has no phone. Pass null —
    /// never a placeholder. The row must still be written, because a handoff we
    /// cannot attribute to a number is precisely the one a human needs to see.
    phone:           string | null
    customerMessage: string
    reason:          HandoffReason
    category?:       string
    blockedOutput?:  string
  },
): Promise<void> {
  await prisma.handoffLog.create({
    data: {
      companyId:       args.companyId,
      conversationId:  args.conversationId,
      phone:           args.phone,
      customerMessage: args.customerMessage,
      reason:          args.reason,
      ...(args.category      && { category:      args.category }),
      ...(args.blockedOutput && { blockedOutput: args.blockedOutput.substring(0, 500) }),
    },
  }).catch(e => console.error('HandoffLog write error:', e))
  console.log(`HANDOFF_LOG → ${args.phone ?? '(no phone — BSUID-only)'} reason=${args.reason}${args.category ? ` cat=${args.category}` : ''}`)
}
