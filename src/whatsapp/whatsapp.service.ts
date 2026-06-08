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

    const msgInclude = { messages: { orderBy: { createdAt: 'asc' as const } } }

    // Find any open (non-closed) conversation for this phone
    let conv = await this.prisma.conversation.findFirst({
      where: { companyId, phone, status: { not: ConvStatus.CLOSED } },
      include: msgInclude,
      orderBy: { updatedAt: 'desc' },
    })

    // ── New conversation ─────────────────────────────────────
    if (!conv) {
      // PART 4: Returning customer check — phone has a previous WON lead
      const hasWonLead = await this.prisma.lead.findFirst({
        where: { companyId, phone, status: LeadStatus.WON },
      })

      const lead = await this.prisma.lead.create({
        data: { companyId, phone, source: 'whatsapp' },
      })

      conv = await this.prisma.conversation.create({
        data: {
          companyId,
          phone,
          leadId: lead.id,
          status: ConvStatus.AI_HANDLING,
          agentMode: hasWonLead ? 'HUMAN' : 'AI',
        },
        include: msgInclude,
      })

      if (hasWonLead) {
        await this.prisma.message.create({
          data: { conversationId: conv.id, role: 'USER', content: text },
        })
        const welcomeBack = 'أهلاً بعودتك، سيتصل بك أحد متخصصينا قريباً.'
        await this.prisma.message.create({
          data: { conversationId: conv.id, role: 'ASSISTANT', content: welcomeBack },
        })
        await this.prisma.conversation.update({
          where: { id: conv.id },
          data: {
            status: ConvStatus.NEEDS_HUMAN,
            agentNotes: 'عميل عائد - تسليم فوري للمبيعات',
          },
        })
        console.log(`RETURNING CUSTOMER → ${phone}`)
        return welcomeBack
      }
    }

    // ── PART 2: HUMAN mode — save message, skip AI ───────────
    if (conv.agentMode === 'HUMAN') {
      await this.prisma.message.create({
        data: { conversationId: conv.id, role: 'USER', content: text },
      })
      console.log(`HUMAN MODE — message saved for ${phone}`)
      return ''
    }

    // ── AI mode but conversation already handed off ───────────
    if (conv.status !== ConvStatus.AI_HANDLING) {
      await this.prisma.message.create({
        data: { conversationId: conv.id, role: 'USER', content: text },
      })
      return ''
    }

    // ── Full AI pipeline ─────────────────────────────────────
    await this.prisma.message.create({
      data: { conversationId: conv.id, role: 'USER', content: text },
    })

    const history = [
      ...conv.messages.map(m => ({ role: m.role === 'USER' ? 'user' : 'assistant', content: m.content })),
      { role: 'user', content: text },
    ]

    const packages = company.packages ?? ''
    const aiPrompt = company.aiPrompt ?? ''
    const waPhone  = company.phone ?? company.ownerPhone ?? ''
    const reply = await getAgentReply(history, company.name, packages, aiPrompt, waPhone)

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

    const { yes, reason } = shouldHandoff(score, history.length + 1, extracted, text)

    if (yes) {
      await this.prisma.conversation.update({
        where: { id: conv.id },
        data: {
          status: ConvStatus.NEEDS_HUMAN,
          agentMode: 'HUMAN',
          agentNotes: `${reason} | Score: ${score}/100`,
        },
      })
      const closing = `شكراً لتواصلك مع ${company.name}. سيتصل بك أحد المتخصصين قريباً.`
      await this.prisma.message.create({
        data: { conversationId: conv.id, role: 'ASSISTANT', content: closing },
      })
      console.log(`HOT LEAD → ${phone} | Score: ${score} | ${reason}`)
      return closing
    }

    return reply
  }
}
