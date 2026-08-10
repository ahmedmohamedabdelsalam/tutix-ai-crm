import { PrismaService } from '../prisma/prisma.service'

export type HandoffReason = 'no_handler' | 'blocked_category' | 'output_guard' | 'repeat_failure' | 'freshness_gate'

// Non-blocking write. Caller does not await — failures are logged, never thrown.
export function logHandoff(
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
): void {
  prisma.handoffLog.create({
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
