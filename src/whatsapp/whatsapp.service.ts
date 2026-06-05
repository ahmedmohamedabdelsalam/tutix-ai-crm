import { Injectable } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { ConvStatus, LeadStatus } from '@prisma/client'
import { getAgentReply, extractLeadData, calculateScore, shouldHandoff } from '../agent/agent.service'

@Injectable()
export class WhatsAppService {
  constructor(private prisma: PrismaService) {}

  async handleMessage(companyId: string, phone: string, text: string): Promise<string> {
    const company = await this.prisma.company.findUnique({ where: { id: companyId } })
    if (!company || !company.isActive) return ''

    // Shared include so findFirst and create return the same type
    const msgInclude = { messages: { orderBy: { createdAt: 'asc' as const } } }

    let conv = await this.prisma.conversation.findFirst({
      where: { companyId, phone, status: 'AI_HANDLING' },
      include: msgInclude,
    })

    if (!conv) {
      const lead = await this.prisma.lead.create({
        data: { companyId, phone, source: 'whatsapp' },
      })
      conv = await this.prisma.conversation.create({
        data: { companyId, phone, leadId: lead.id, status: 'AI_HANDLING' },
        include: msgInclude,
      })
    }

    if (conv.status !== 'AI_HANDLING') return ''

    await this.prisma.message.create({
      data: { conversationId: conv.id, role: 'USER', content: text },
    })

    const history = [
      ...conv.messages.map(m => ({ role: m.role === 'USER' ? 'user' : 'assistant', content: m.content })),
      { role: 'user', content: text },
    ]

    const packages = company.packages ?? 'عمرة اقتصادي - عمرة VIP - حج'
    const reply = await getAgentReply(history, company.name, packages)

    await this.prisma.message.create({
      data: { conversationId: conv.id, role: 'ASSISTANT', content: reply },
    })

    const extracted = await extractLeadData([...history, { role: 'assistant', content: reply }])
    const score = calculateScore(extracted)

    await this.prisma.lead.updateMany({
      where: { companyId, phone },
      data: {
        ...(extracted.name && { name: extracted.name }),
        ...(extracted.packageType && { packageType: extracted.packageType }),
        ...(extracted.groupSize && { groupSize: extracted.groupSize }),
        ...(extracted.budget && { budget: extracted.budget }),
        ...(extracted.travelDate && { travelDate: extracted.travelDate }),
        score,
        isHot: score >= 70,
        status: score >= 70 ? LeadStatus.HOT : LeadStatus.CONTACTED,
      },
    })

    const { yes, reason } = shouldHandoff(score, history.length + 1, extracted)

    if (yes) {
      await this.prisma.conversation.update({
        where: { id: conv.id },
        data: { status: ConvStatus.NEEDS_HUMAN, agentNotes: `${reason} | Score: ${score}/100` },
      })
      const closing = `شكراً لتواصلك مع ${company.name}! سيتصل بك أحد متخصصينا قريباً إن شاء الله 🕌`
      await this.prisma.message.create({
        data: { conversationId: conv.id, role: 'ASSISTANT', content: closing },
      })
      console.log(`🔥 HOT LEAD → ${phone} | Score: ${score} | ${reason}`)
      return closing
    }

    return reply
  }
}
