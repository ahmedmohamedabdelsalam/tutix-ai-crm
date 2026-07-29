import { PrismaService } from '../prisma/prisma.service'

export type HandoffReason = 'no_handler' | 'blocked_category' | 'output_guard' | 'repeat_failure'

// Non-blocking write. Caller does not await — failures are logged, never thrown.
export function logHandoff(
  prisma: PrismaService,
  args: {
    companyId:       string
    conversationId:  string
    phone:           string
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
  console.log(`HANDOFF_LOG → ${args.phone} reason=${args.reason}${args.category ? ` cat=${args.category}` : ''}`)
}
