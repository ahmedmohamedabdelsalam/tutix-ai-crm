import { Injectable } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { ConvStatus, LeadStatus } from '@prisma/client'
import { getAgentReply, extractLeadData, calculateScore, shouldHandoff, LeadData } from '../agent/agent.service'

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
        const welcomeBack = 'أهلاً بعودتك يافندم نورتنا تاني سيتواصل معك أحد متخصصينا قريباً إن شاء الله'
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

    // ── PART 2: HUMAN mode — save message ───────────────────
    if (conv.agentMode === 'HUMAN') {
      await this.prisma.message.create({
        data: { conversationId: conv.id, role: 'USER', content: text },
      })

      // NEEDS_HUMAN = still waiting for a human agent → AI responds normally
      // (per system prompt: "لو حصل تحويل وبعدين العميل بعت رسالة تانية — جاوبه عادي")
      if (conv.status === ConvStatus.NEEDS_HUMAN) {
        const freshMsgs = await this.prisma.message.findMany({
          where: { conversationId: conv.id },
          orderBy: { createdAt: 'asc' },
        })
        const historyNH = freshMsgs.map(m => ({
          role: m.role === 'USER' ? 'user' : 'assistant',
          content: m.content,
        }))
        const packagesNH = company.packages ?? ''
        const aiPromptNH = company.aiPrompt ?? ''
        const waPhoneNH  = company.phone ?? company.ownerPhone ?? ''
        const replyNH = await getAgentReply(historyNH, company.name, packagesNH, aiPromptNH, waPhoneNH, company.industry)
        await this.prisma.message.create({
          data: { conversationId: conv.id, role: 'ASSISTANT', content: replyNH },
        })
        console.log(`POST-HANDOFF AI — ${phone}`)
        return replyNH
      }

      // Any other status (CLOSED, etc.) = human agent has fully taken over → silence
      console.log(`HUMAN MODE (${conv.status}) — message saved for ${phone}`)
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

    // Reload from DB after saving — avoids race condition where conv.messages is a stale snapshot
    const freshMessages = await this.prisma.message.findMany({
      where: { conversationId: conv.id },
      orderBy: { createdAt: 'asc' },
    })
    const history = freshMessages.map(m => ({
      role: m.role === 'USER' ? 'user' : 'assistant',
      content: m.content,
    }))

    const packages = company.packages ?? ''
    const aiPrompt = company.aiPrompt ?? ''
    const waPhone  = company.phone ?? company.ownerPhone ?? ''
    const reply = await getAgentReply(history, company.name, packages, aiPrompt, waPhone, company.industry)

    await this.prisma.message.create({
      data: { conversationId: conv.id, role: 'ASSISTANT', content: reply },
    })

    // Run extractLeadData on msg 1-2 (capture name early), every 3rd message,
    // or whenever the customer's message contains a booking keyword.
    const BOOKING_SIGNALS = ['عايز احجز', 'عايزة احجز', 'هحجز', 'احجزلي', 'موافق نحجز', 'خد الحجز'];
    const msgCount = history.length; // includes the just-saved user message
    const hasBookingSignal = BOOKING_SIGNALS.some(kw => text.includes(kw));
    const runExtract = msgCount <= 2 || msgCount % 3 === 0 || hasBookingSignal;
    console.log(`EXTRACT: msg=${msgCount} run=${runExtract} (booking=${hasBookingSignal} mod3=${msgCount % 3 === 0})`);

    let extracted: Partial<LeadData> = {}
    let score = 0
    if (runExtract) {
      extracted = await extractLeadData([...history, { role: 'assistant', content: reply }])
      score = calculateScore(extracted)
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
    }

    const { yes, reason } = shouldHandoff(score, history.length, extracted, text)

    if (yes) {
      await this.prisma.conversation.update({
        where: { id: conv.id },
        data: {
          status: ConvStatus.NEEDS_HUMAN,
          agentMode: 'HUMAN',
          agentNotes: `${reason} | Score: ${score}/100`,
        },
      })
      const closing = 'تمام يافندم هحول حضرتك لزميلي المختص يكمل معاك خطوات الحجز إن شاء الله'
      await this.prisma.message.create({
        data: { conversationId: conv.id, role: 'ASSISTANT', content: closing },
      })
      console.log(`HOT LEAD → ${phone} | Score: ${score} | ${reason}`)
      return closing
    }

    return reply
  }
}
