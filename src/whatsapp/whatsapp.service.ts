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

const SHORT_WAIT = /دقيقة|لحظة|ثانية|ثواني|شوية|كمان شوية/
const REAL_DURATION = /يوم|أيام|بكر[هة]|أسبوع|شهر/

const DEFERRAL_PHRASES = [
  'هتأكد مع الفريق', 'فريقنا هيتابع', 'الأفضل الرجوع لـ',
  'مش متاكد', 'مش متأكد', 'هتأكدلك', 'هتأكد لك', 'هتأكد للحضرتك',
]

export function detectFollowUpIntent(
  text: string,
  history: { role: string; content: string }[],
): { shouldSchedule: boolean; days: number; declined: boolean } {
  const t = text.trim()

  // Hard decline: customer refuses to be contacted
  if (HARD_DECLINE.some(kw => t.includes(kw))) {
    return { shouldSchedule: false, days: 0, declined: true }
  }

  // Short-wait filler phrases ("دقيقة"/"لحظة"/"شوية") mean "I'll reply soon myself"
  // — not a deferred-contact request. Bail out unless a real duration word is also present.
  if (SHORT_WAIT.test(t) && !REAL_DURATION.test(t)) {
    return { shouldSchedule: false, days: 0, declined: false }
  }

  // Explicit duration + deferring intent → schedule immediately
  // Guard: require deferring intent so trip-duration answers like "٧ أيام" don't trigger scheduling
  const days = parseDaysFromText(t)
  if (days !== null && DEFER_INTENT.test(t)) {
    return { shouldSchedule: true, days, declined: false }
  }

  // Previous agent message was a proposal → check if customer agreed.
  // Guard: the user message that triggered the proposal must have had DEFER_INTENT.
  // Without this, a misfired proposal (AI over-interpreting "ت" as "هفكر") would let
  // the next innocent "تمام" schedule a follow-up.
  const msgs = [...history]
  const lastBotIdx = msgs.reduce<number>((found, m, i) => m.role === 'assistant' ? i : found, -1)
  if (lastBotIdx >= 0 && isFollowUpProposal(msgs[lastBotIdx].content)) {
    const userBeforeBot = msgs.slice(0, lastBotIdx).reverse().find(m => m.role === 'user')
    if (userBeforeBot && DEFER_INTENT.test(userBeforeBot.content)) {
      // For short single-word agreement, match exact; for longer words, include substring
      if (AGREEMENT.some(w => t === w || (w.length > 3 && t.includes(w)))) {
        return { shouldSchedule: true, days: 1, declined: false }
      }
      // Customer counter-proposes a different duration ("لأ بعد يومين أحسن")
      if (days !== null) return { shouldSchedule: true, days, declined: false }
    }
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
  private faqCache = new Map<string, { data: { question: string; answer: string }[]; expiresAt: number }>()

  constructor(private prisma: PrismaService) {}

  private async getCompanyFAQ(companyId: string): Promise<{ question: string; answer: string }[]> {
    const cached = this.faqCache.get(companyId)
    if (cached && cached.expiresAt > Date.now()) {
      console.log(`FAQ_CACHE HIT — companyId=${companyId}`)
      return cached.data
    }
    const faqs = await this.prisma.companyFAQ.findMany({
      where: { companyId, isActive: true },
      select: { question: true, answer: true },
      orderBy: { createdAt: 'asc' },
    })
    this.faqCache.set(companyId, { data: faqs, expiresAt: Date.now() + 10 * 60 * 1000 })
    console.log(`FAQ_CACHE MISS — companyId=${companyId} fetched ${faqs.length} FAQs`)
    return faqs
  }

  async handleMessage(companyId: string, phone: string, text: string, source = 'direct', referralData?: object | null): Promise<string> {
    const company = await this.prisma.company.findUnique({ where: { id: companyId } })
    if (!company || !company.isActive) return ''

    // First message ever received → stamp waTokenUpdatedAt so the 60-day clock starts now.
    if (!company.waTokenUpdatedAt) {
      const now = new Date()
      const expiresAt = new Date(now.getTime() + 60 * 86_400_000)
      this.prisma.company.update({
        where: { id: companyId },
        data: { waTokenUpdatedAt: now, waTokenExpiresAt: expiresAt },
      }).catch(() => {})
    }

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

    // knownCustomerName is set here when we find an existing lead with a name — used later
    // in getAgentReply so the AI greets by name instead of asking again
    let knownCustomerName: string | undefined

    // ── New conversation ─────────────────────────────────────
    if (!conv) {
      // ONE canonical Lead per phone+companyId — reuse if exists, never duplicate
      const existingLead = await this.prisma.lead.findFirst({
        where: { companyId, phone },
        orderBy: { createdAt: 'asc' },
      })
      const hasWonLead = existingLead?.status === LeadStatus.WON
      knownCustomerName = existingLead?.name ?? undefined
      console.log(`NEW_CONV → phone=${phone} existingLead=${existingLead?.id ?? 'null'} knownName=${knownCustomerName ?? 'undefined'}`)
      const lead = existingLead ?? await this.prisma.lead.create({
        data: {
          companyId, phone, source,
          ...(referralData && { referralData }),
        },
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

    // For existing conversations: resolve customer name from the Lead record so the AI
    // can address them by name even when early messages fall outside the 10-msg history window.
    if (!knownCustomerName && conv.leadId) {
      const lead = await this.prisma.lead.findUnique({
        where: { id: conv.leadId },
        select: { name: true },
      })
      if (lead?.name) knownCustomerName = lead.name
    }

    // ── PART 2: HUMAN mode — save message ───────────────────
    if (conv.agentMode === 'HUMAN') {
      await this.prisma.message.create({
        data: { conversationId: conv.id, role: 'USER', content: text },
      })

      // NEEDS_HUMAN = still waiting for a human agent → AI responds normally
      // (per system prompt: "لو حصل تحويل وبعدين العميل بعت رسالة تانية — جاوبه عادي")
      if (conv.status === ConvStatus.NEEDS_HUMAN) {
        // Repeat booking keyword after handoff already sent → short ack, no AI call, no phone repeat
        const BOOKING_REPEAT = ['عايز احجز', 'عايزة احجز', 'هحجز', 'احجزلي', 'عايز أحجز', 'عايزة أحجز', 'موافق نحجز']
        if (conv.handoffMessageSent && BOOKING_REPEAT.some(kw => text.includes(kw))) {
          const repeatAck = 'تمام يافندم زميلنا هيتواصل معك في أقرب وقت إن شاء الله'
          await this.prisma.message.create({
            data: { conversationId: conv.id, role: 'ASSISTANT', content: repeatAck },
          })
          console.log(`REPEAT_BOOKING_ACK → ${phone}`)
          return repeatAck
        }

        const freshMsgs = await this.prisma.message.findMany({
          where: { conversationId: conv.id },
          orderBy: { createdAt: 'desc' },
          take: 10,
        })
        const historyNH = freshMsgs.reverse().map(m => ({
          role: m.role === 'USER' ? 'user' : 'assistant',
          content: m.content,
        }))
        const packagesNH = company.packages ?? ''
        const aiPromptNH = company.aiPrompt ?? ''
        // Suppress phone in CTA once handoff message already sent — prevents repeat
        const waPhoneNH  = conv.handoffMessageSent ? '' : (company.phone ?? company.ownerPhone ?? '')
        const faqsNH = await this.getCompanyFAQ(companyId)
        const replyNH = await getAgentReply(historyNH, company.name, packagesNH, aiPromptNH, waPhoneNH, company.industry, undefined, knownCustomerName, faqsNH)
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

    // Count total messages for extract-frequency tracking (history.length would be capped at 10
    // after the limit below, causing % 5 to fire on every message once conv exceeds 10 msgs).
    const totalMsgCount = await this.prisma.message.count({ where: { conversationId: conv.id } })

    // Reload from DB — limit to last 10 messages to cap input tokens.
    // Customer name is preserved via knownCustomerName (from Lead record), not message history.
    const freshMessages = await this.prisma.message.findMany({
      where: { conversationId: conv.id },
      orderBy: { createdAt: 'desc' },
      take: 10,
    })
    const history = freshMessages.reverse().map(m => ({
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

    const companyFAQs = await this.getCompanyFAQ(companyId)

    // Meaningless-short guard: 1–2 Arabic chars with no semantic content = accidental tap / typo.
    // Handled here in code so the LLM never sees these inputs and can't mis-apply clarification rules.
    // Whitelisted 1–2 char words that ARE genuine responses (حج, اه/yes, لا/no, etc.) pass through.
    const SHORT_WHITELIST = new Set([
      'حج',                           // hajj
      'لأ', 'لا',                     // no
      'اه', 'أه', 'آه', 'اى', 'اي', 'إي', // yes / affirmative
    ])
    const trimmedText = text.trim()
    if (/^[ء-ي]{1,2}$/.test(trimmedText) && !SHORT_WHITELIST.has(trimmedText)) {
      const clarify = 'معلش يافندم مفهمتش، تحب تقولي إيه بالتحديد؟'
      await this.prisma.message.create({
        data: { conversationId: conv.id, role: 'ASSISTANT', content: clarify },
      })
      console.log(`SHORT-MSG GUARD → ${phone} sent "${trimmedText}"`)
      return clarify
    }

    const reply = await getAgentReply(history, company.name, packages, aiPrompt, waPhone, company.industry, returningCustomer, knownCustomerName, companyFAQs)

    await this.prisma.message.create({
      data: { conversationId: conv.id, role: 'ASSISTANT', content: reply },
    })

    // Non-blocking: log deferral events for analytics
    if (DEFERRAL_PHRASES.some(p => reply.includes(p))) {
      this.prisma.agentInsight.create({
        data: { companyId, conversationId: conv.id, type: 'deferred_question', content: text },
      }).catch(e => console.error('AgentInsight write error:', e))
    }

    // Run extractLeadData on msg 1-2 (capture name early), every 3rd message,
    // or whenever the customer's message contains a booking keyword.
    const BOOKING_SIGNALS = ['عايز احجز', 'عايزة احجز', 'هحجز', 'احجزلي', 'موافق نحجز', 'خد الحجز'];
    const msgCount = totalMsgCount; // total msgs in DB (not history.length, which is capped at 10)
    const hasBookingSignal = BOOKING_SIGNALS.some(kw => text.includes(kw));
    const runExtract = msgCount <= 2 || msgCount % 5 === 0 || hasBookingSignal;
    console.log(`EXTRACT: msg=${msgCount} run=${runExtract} (booking=${hasBookingSignal} mod5=${msgCount % 5 === 0})`);

    let extracted: Partial<LeadData> = {}
    let score = 0
    if (runExtract) {
      extracted = await extractLeadData([...history, { role: 'assistant', content: reply }])
      score = calculateScore(extracted)
      await this.prisma.lead.updateMany({
        where: { companyId, phone },
        data: {
          ...(extracted.name && !knownCustomerName && { name: extracted.name }),
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
      // Guard: if the AI self-triggered the handoff CTA (should not happen but prompt is non-deterministic),
      // stamp handoffMessageSent so the phone number is suppressed on the next code-level handoff.
      const AI_HANDOFF_PATTERN = /هحول حضرتك لزميلي|زميلنا هيتواصل/
      if (AI_HANDOFF_PATTERN.test(reply) && !conv.handoffMessageSent) {
        await this.prisma.conversation.update({
          where: { id: conv.id },
          data: { handoffMessageSent: true },
        })
        console.log(`AI_SELF_HANDOFF DETECTED → ${phone} — handoffMessageSent stamped`)
      }

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
    // First time → full message with contact number. Repeat → short acknowledgment only.
    const closingFull = waPhone
      ? `تمام يافندم هحول حضرتك لزميلي المختص يكمل معاك خطوات الحجز إن شاء الله وللتواصل المباشر: ${waPhone}`
      : 'تمام يافندم هحول حضرتك لزميلي المختص يكمل معاك خطوات الحجز إن شاء الله'
    const closingRepeat = 'تمام يافندم زميلنا هيتواصل معك في أقرب وقت إن شاء الله'
    const closing = conv.handoffMessageSent ? closingRepeat : closingFull

    await this.prisma.conversation.update({
      where: { id: conv.id },
      data: {
        status: ConvStatus.NEEDS_HUMAN,
        agentMode: 'HUMAN',
        agentNotes: `${reason} | Score: ${score}/100`,
        handoffMessageSent: true,
      },
    })
    await this.prisma.message.create({
      data: { conversationId: conv.id, role: 'ASSISTANT', content: closing },
    })
    console.log(`HOT LEAD → ${phone} | Score: ${score} | ${reason} | firstHandoff=${!conv.handoffMessageSent}`)
    return closing
  }
}
