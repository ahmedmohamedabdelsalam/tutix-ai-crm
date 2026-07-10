import { PrismaService } from '../prisma/prisma.service'

export async function handleAICreditsExhausted(prisma: PrismaService, companyId: string): Promise<void> {
  console.error(`🔴 ANTHROPIC_CREDITS_EXHAUSTED — companyId=${companyId}`)
  prisma.systemNotification.create({
    data: {
      companyId,
      type: 'API_CREDITS_LOW',
      message: 'تنبيه عاجل: رصيد Anthropic API نفذ — النظام متوقف عن الرد على العملاء',
    },
  }).catch(e => console.error('SystemNotification create error:', e))
}

export function writeCostRecord(prisma: PrismaService, companyId: string, conversationId: string, costUSD: number): void {
  if (costUSD <= 0) return
  prisma.agentInsight.create({
    data: {
      companyId,
      conversationId,
      type: 'api_cost',
      category: new Date().toISOString().slice(0, 10),
      content: costUSD.toFixed(6),
    },
  }).catch(e => console.error('AgentInsight cost write error:', e))
}
