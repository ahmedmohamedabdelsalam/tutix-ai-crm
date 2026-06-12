import { Injectable } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { ConvStatus, FollowUpStatus, LeadStatus } from '@prisma/client'
import { getAgentReply, extractLeadData, calculateScore, shouldHandoff, LeadData } from '../agent/agent.service'

// ── Follow-up scheduling utilities ──────────────────────────────────────────

const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩'
const CAIRO_OFFSET_MS = 2 * 60 * 60 * 1000

function parseDaysFromText(text: string): number | null {
  if (/بكر[هة]|يوم واحد/.test(text)) return 1
  if (/يومين/.test(text)) return 2
  if (/أسبوعين/.test(text)) return 14
  if (/الأسبوع الجاي|بعد أسبوع|في أسبوع/.test(text)) return 7
  const m = text.match(/([٠١٢٣٤٥٦٧٨٩]+|[0-9]+)\s*(?:أيام?|يوم)/)
  if (m) {
    const n = parseInt(m[1].split('').map(c => { const i = ARABIC_INDIC.indexOf(c); return i >= 0 ? String(i) : c }).join(''))
    if (!isNaN(n) && n >= 1 && n <= 30) return n
  }
  return null
}

function isFollowUpProposal(msg: string): boolean {
  // Agent message contains "بكرة" + a contact-intent verb → it was a follow-up proposal
  return /بكر[هة]/.test(msg) &&
    /أتواصل|هتواصل|هأتواصل|هاتواصل|هكلمك|أكلمك|هرد عليك/.test(msg)
}

const HARD_DECLINE = [
  'أنا هكلمك', 'أنا اللي هكلمك', 'هكلمك أنا', 'متتصلش', 'بلاش تتصل', 'بلاش تكلمني',
]
// Words that indicate the customer is deferring / asking to be called back
const DEFER_INTENT = /هفكر|بفكر|خليني افكر|هرد عليك|رد عليا|كلمني|تواصل معي|بعد كده/

const AGREEMENT = ['ماشي', 'تمام', 'أيوه', 'أوكي', 'اوكي', 'موافق', 'أكيد', 'اكيد', 'حاضر']

export function detectFollowUpIntent(
  text: string,
  history: { role: string; content: string }[],
): { shouldSchedule: boolean; days: number; declined: boolean } {
  const t = text.trim()

  // Hard decline: customer refuses to be contacted
  if (HARD_DECLINE.some(kw => t.includes(kw))) {
    return { shouldSchedule: false, days: 0, declined: true }
  }

  // Explicit duration + deferring intent → schedule immediately
  // Guard: require deferring intent so trip-duration answers like "٧ أيام" don't trigger scheduling
  const days = parseDaysFromText(t)
  if (days !== null && DEFER_INTENT.test(t)) {
    return { shouldSchedule: true, days, declined: false }
  }

  // Previous agent message was a proposal → check if customer agreed
  const lastBot = [...history].reverse().find(m => m.role === 'assistant')
  if (lastBot && isFollowUpProposal(lastBot.content)) {
    // For short single-word agreement, match exact; for longer words, include substring
    if (AGREEMENT.some(w => t === w || (w.length > 3 && t.includes(w)))) {
      return { shouldSchedule: true, days: 1, declined: false }
    }
    // Customer counter-proposes a different duration ("لأ بعد يومين أحسن")
    if (days !== null) return { shouldSchedule: true, days, declined: false }
  }

  return { shouldSchedule: false, days: 0, declined: false }
}

export function clampToWindow(date: Date): Date {
  const cairoHour = new Date(date.getTime() + CAIRO_OFFSET_MS).getUTCHours()
  if (cairoHour >= 9 && cairoHour < 22) return date
  const c = new Date(date.getTime() + CAIRO_OFFSET_MS)
  if (cairoHour >= 22) c.setUTCDate(c.getUTCDate() + 1)
  c.setUTCHours(9, 0, 0, 0)
  return new Date(c.getTime() - CAIRO_OFFSET_MS)
}

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

    // Cancel any pending follow-up — customer replied before the deadline
    if (conv?.followUpStatus === FollowUpStatus.SCHEDULED) {
      await this.prisma.conversation.update({
        where: { id: conv.id },
        data: { followUpStatus: FollowUpStatus.CANCELLED, followUpScheduledAt: null },
      })
      console.log(`FOLLOW-UP CANCELLED — ${phone} replied before deadline`)
    }

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

    // Check for a pipeline-sourced returning customer (source != legacy so phone always exists)
    const permCustomer = await this.prisma.permanentCustomer.findFirst({
      where: { companyId, phone, source: { not: 'legacy' } },
      select: { fullName: true, tripsCount: true },
    })
    const returningCustomer = permCustomer
      ? { name: permCustomer.fullName, tripsCount: permCustomer.tripsCount }
      : undefined

    const packages = company.packages ?? ''
    const aiPrompt = company.aiPrompt ?? ''
    const waPhone  = company.phone ?? company.ownerPhone ?? ''
    const reply = await getAgentReply(history, company.name, packages, aiPrompt, waPhone, company.industry, returningCustomer)

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

    if (!yes) {
      // Detect follow-up scheduling intent (only when not handing off)
      const fu = detectFollowUpIntent(text, history)
      if (fu.shouldSchedule) {
        const at = clampToWindow(new Date(Date.now() + fu.days * 24 * 60 * 60 * 1000))
        await this.prisma.conversation.update({
          where: { id: conv.id },
          data: { followUpScheduledAt: at, followUpStatus: FollowUpStatus.SCHEDULED },
        })
        console.log(`FOLLOW-UP SCHEDULED → ${phone} in ${fu.days}d at ${at.toISOString()}`)
      } else if (fu.declined) {
        console.log(`FOLLOW-UP DECLINED → ${phone}`)
      }
      return reply
    }

    // Handoff: booking confirmed
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
}
