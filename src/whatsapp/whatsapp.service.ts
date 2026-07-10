import { Injectable } from '@nestjs/common'
import { toArabicIndic } from '../utils/arabic-numerals'
import { PrismaService } from '../prisma/prisma.service'
import { ConvStatus, FollowUpStatus, LeadStatus } from '@prisma/client'
import { getAgentReply, extractLeadData, calculateScore, shouldHandoff, LeadData, LeadFacts, PrebuiltCatalog, ApiCreditsExhaustedError, AI_ERROR_REPLY, BOOKING_KEYWORDS } from '../agent/agent.service'
import { buildIndustryPromptFromDB } from '../agent/prompts/dynamic-catalog-builder'
import { splitIntoMessages } from './message-splitter'
import { applyHajjDateDisclaimer } from './hajj-date-disclaimer'
import { companionConfirmedInHistory, travelDateConfirmedInHistory } from './lead-fact-guards'
import { detectOnlinePayment, detectFarFromBranch, detectVisitConfirm } from './booking-stage-detectors'
import { getGovFromText, branchMessage } from './branch-lookup'
import { containsFirstMessageQuestion, detectUmrahMonth, detectFullDetailsIntent, detectContinueResponse, detectHajjOverviewIntent, detectNumberReply } from './intent-detectors'

import { detectFollowUpIntent, clampToWindow, DEFERRAL_PHRASES } from './follow-up-scheduler'
import { handleAICreditsExhausted, writeCostRecord } from './ai-cost-helpers'
import { saveAssistantMessage, completeBookingAlert } from './message-persistence'

interface FullDetailsState {
  offset: number
  total: number
}

interface OverviewState {
  orderedDetails: string[]  // pre-rendered detail strings, index 0 = item ١ in the overview
}

const HAJJ_OV_DISCLAIMER =
  'ملاحظة: التواريخ الهجرية لبرامج الحج ١٤٤٨هـ تقديرية بناءً على الحساب الفلكي وسيُعلن الرسمي منها بعد رؤية الهلال قبل الموسم بأسابيع'


@Injectable()
export class WhatsAppService {
  private faqCache = new Map<string, { data: { question: string; answer: string }[]; expiresAt: number }>()
  private readonly aiFailureCount = new Map<string, number>()
  private readonly fullDetailsMap = new Map<string, FullDetailsState>()
  private readonly overviewMap    = new Map<string, OverviewState>()

  constructor(private prisma: PrismaService) {}




  private async getPrebuiltCatalog(companyId: string, companyName: string): Promise<PrebuiltCatalog | undefined> {
    if (process.env.USE_DB_CATALOG !== 'true') return undefined
    const config = await this.prisma.companyAIConfig.findUnique({ where: { companyId } })
    if (!config) { console.log(`DB_CATALOG: no config for companyId=${companyId}`); return undefined }
    console.log(`DB_CATALOG: loaded config id=${config.id} company=${companyName}`)
    return buildIndustryPromptFromDB(config as any, companyName)
  }

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

  async handleMessage(companyId: string, phone: string, text: string, source = 'direct', referralData?: object | null): Promise<string | string[]> {
    const company = await this.prisma.company.findUnique({ where: { id: companyId } })
    if (!company || !company.isActive) return ''

    const msgInclude = { messages: { orderBy: { createdAt: 'asc' as const } } }

    // Find any open (non-closed) conversation for this phone
    let conv
    try {
      conv = await this.prisma.conversation.findFirst({
        where: { companyId, phone, status: { not: ConvStatus.CLOSED } },
        include: msgInclude,
        orderBy: { updatedAt: 'desc' },
      })
    } catch (err) {
      console.error(`DB_ERROR conversation.findFirst phone=${phone} companyId=${companyId}`, err)
      return ''
    }

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
      try {
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
          await saveAssistantMessage(this.prisma, conv.id, welcomeBack)
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
      } catch (err) {
        console.error(`DB_ERROR lead/conversation create phone=${phone} companyId=${companyId}`, err)
        return ''
      }
    }

    // Resolve customer name and confirmed facts from the Lead record so the AI never re-asks
    // for info already captured — even when early messages fall outside the 10-msg history window.
    //
    // SECURITY: groupSize and companionNote are Cross-Session Leak risks.
    // The Lead record is shared across ALL conversations for the same phone. If a customer said
    // "أنا ووالدتي" in a past session, companionNote is stored on the Lead forever. Injecting it
    // into a new session where they said NOTHING about companions causes the AI to fabricate
    // "معاك والدتك يعني شخصين". Gate these two fields: only carry them forward when the CURRENT
    // conversation's own messages already mention a companion or group.
    let knownLeadFacts: LeadFacts | undefined
    if (conv.leadId) {
      const lead = await this.prisma.lead.findUnique({
        where: { id: conv.leadId },
        select: { name: true, packageType: true, groupSize: true, travelDate: true, budget: true, companionNote: true },
      })
      if (!knownCustomerName && lead?.name) knownCustomerName = lead.name
      if (lead && (lead.packageType || lead.groupSize != null || lead.travelDate || lead.budget || lead.companionNote)) {
        const companionInThisConv = companionConfirmedInHistory(conv.messages ?? [])
        const monthInThisConv = travelDateConfirmedInHistory(conv.messages ?? [])
        knownLeadFacts = {
          packageType: lead.packageType,
          budget: lead.budget,
          // Only carry over session-specific facts if THIS conversation already confirms them —
          // prevents stale data from a prior session being asserted as current confirmed context.
          travelDate:    monthInThisConv    ? lead.travelDate    : undefined,
          groupSize:     companionInThisConv ? lead.groupSize     : undefined,
          companionNote: companionInThisConv ? lead.companionNote : undefined,
        }
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
        // ── Booking flow stage handlers ───────────────────────────────────────
        if (conv.bookingStage === 'AWAITING_GOVERNORATE') {
          const gov = getGovFromText(text)
          if (gov) {
            if (conv.leadId) await this.prisma.lead.update({ where: { id: conv.leadId }, data: { governorate: gov } })
            const bMsg = `شكراً يافندم! بناءً على موقعك في ${gov} — أقرب فرع ليك هو:\n${branchMessage(gov)}\n\nهتيجي للفرع لإتمام الحجز؟`
            await this.prisma.conversation.update({ where: { id: conv.id }, data: { bookingStage: 'AWAITING_BRANCH_CONFIRM' } })
            await saveAssistantMessage(this.prisma, conv.id, bMsg)
            console.log(`BOOKING_GOV_RESOLVED → ${phone} gov=${gov}`)
            return bMsg
          }
          const askAgain = 'معلش يافندم، مفهمتش — حضرتك من أنهي محافظة بالضبط؟'
          await saveAssistantMessage(this.prisma, conv.id, askAgain)
          return askAgain
        }

        if (conv.bookingStage === 'AWAITING_BRANCH_CONFIRM') {
          if (detectOnlinePayment(text)) {
            const r = 'تمام يافندم، هنترتبلك مع زميلنا المختص بخصوص طريقة الدفع الأونلاين وسيتواصل معك قريباً إن شاء الله'
            await completeBookingAlert(this.prisma, conv.id, companyId, phone, 'wants_online_payment', r)
            return r
          }
          if (detectFarFromBranch(text)) {
            const r = 'تمام يافندم، هنترتبلك أنسب حاجة مع زميلنا المختص وسيتواصل معك قريباً إن شاء الله'
            await completeBookingAlert(this.prisma, conv.id, companyId, phone, 'far_from_branch', r)
            return r
          }
          if (detectVisitConfirm(text)) {
            const r = 'ممتاز يافندم! فريقنا هيكون في انتظارك بالفرع إن شاء الله، وأي استفسار أنا هنا'
            await completeBookingAlert(this.prisma, conv.id, companyId, phone, 'wants_branch_visit', r)
            return r
          }
          const clarify = 'معلش يافندم، هتيجي للفرع؟ أم تفضل يتواصل معك أحد زملائنا؟'
          await saveAssistantMessage(this.prisma, conv.id, clarify)
          return clarify
        }

        // After booking confirmed — short ack for any follow-up messages
        if (conv.needsSalesContact) {
          const ack = 'تمام يافندم، فريق المبيعات هيتواصل معك قريباً إن شاء الله'
          await saveAssistantMessage(this.prisma, conv.id, ack)
          return ack
        }

        // Repeat booking keyword after handoff already sent → short ack, no AI call
        if (conv.handoffMessageSent && BOOKING_KEYWORDS.some(kw => text.includes(kw))) {
          const repeatAck = 'تمام يافندم زميلنا هيتواصل معك في أقرب وقت إن شاء الله'
          await saveAssistantMessage(this.prisma, conv.id, repeatAck)
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
        const prebuiltCatalogNH = await this.getPrebuiltCatalog(companyId, company.name)
        let rawNHReply = AI_ERROR_REPLY
        try {
          const r = await getAgentReply(historyNH, company.name, packagesNH, aiPromptNH, waPhoneNH, company.industry, undefined, knownCustomerName, faqsNH, knownLeadFacts, prebuiltCatalogNH)
          rawNHReply = r.reply
          writeCostRecord(this.prisma, companyId, conv.id, r.costUSD)
        } catch (err) {
          if (err instanceof ApiCreditsExhaustedError) await handleAICreditsExhausted(this.prisma, companyId)
        }
        const replyNH = applyHajjDateDisclaimer(rawNHReply)
        await saveAssistantMessage(this.prisma, conv.id, replyNH)
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

    // Supplement knownLeadFacts with service type detected directly from user messages.
    // The AI extract sometimes returns null for packageType on the first message exchange,
    // so we detect it here from history to prevent the AI from re-asking.
    if (!knownLeadFacts?.packageType && history.length > 1) {
      const userText = history.filter(m => m.role === 'user').map(m => m.content).join(' ')
      if (/عمرة|عمره/.test(userText)) {
        knownLeadFacts = { ...knownLeadFacts, packageType: 'عمرة' }
      } else if (/\bحج\b/.test(userText)) {
        knownLeadFacts = { ...knownLeadFacts, packageType: 'حج' }
      }
    }

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
    const prebuiltCatalog = await this.getPrebuiltCatalog(companyId, company.name)

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
      await saveAssistantMessage(this.prisma, conv.id, clarify)
      console.log(`SHORT-MSG GUARD → ${phone} sent "${trimmedText}"`)
      return clarify
    }

    // ── Code-driven full-details mode: chunked hajj program delivery ────────────
    // The AI truncates when asked to show all 9 programs at once. This path bypasses
    // the AI entirely and delivers exactly 3 programs per message, code-built.
    if (prebuiltCatalog?.hajjProgramDetails?.length) {
      const fdState = this.fullDetailsMap.get(conv.id)
      const isContinue = !!fdState && detectContinueResponse(text)
      const isNewRequest = !fdState && detectFullDetailsIntent(text)

      if (isContinue || isNewRequest) {
        const details = prebuiltCatalog.hajjProgramDetails
        const total = details.length
        const offset = isContinue ? fdState!.offset : 0
        const chunkItems = details.slice(offset, offset + 3)
        const nextOffset = offset + chunkItems.length
        const isLast = nextOffset >= total

        const chunkText = chunkItems.join('\n\n')
        const closingLine = isLast
          ? `كده عرضتلك كل البرامج يافندم — أنهي واحد قرب لقلبك؟`
          : `دول ${toArabicIndic(nextOffset)} من ${toArabicIndic(total)} يافندم — أكملك الباقي؟`
        const fdReply = `${chunkText}\n\n${closingLine}`

        if (isLast) this.fullDetailsMap.delete(conv.id)
        else this.fullDetailsMap.set(conv.id, { offset: nextOffset, total })

        await saveAssistantMessage(this.prisma, conv.id, fdReply)
        console.log(`FD_CHUNK → ${phone} offset=${offset}..${nextOffset - 1}/${total} isLast=${isLast}`)
        return fdReply
      }

      if (fdState && !isContinue) {
        this.fullDetailsMap.delete(conv.id)
      }
    }

    // ── Overview state: number-reply handler (all message counts) ────────────────
    // When a customer replies with a number after seeing the Hajj overview, deliver
    // that program's full details directly from the pre-rendered array — no AI involved.
    if (prebuiltCatalog) {
      const ovState = this.overviewMap.get(conv.id)
      if (ovState) {
        const n = detectNumberReply(text)
        if (n !== null && n >= 1 && n <= ovState.orderedDetails.length) {
          const detail = applyHajjDateDisclaimer(ovState.orderedDetails[n - 1])
          this.overviewMap.delete(conv.id)
          await saveAssistantMessage(this.prisma, conv.id, detail)
          console.log(`OV_NUMBER → ${phone} n=${n} → program detail sent`)
          return detail
        }
        // Topic changed — clear overview state and let normal AI handle it
        this.overviewMap.delete(conv.id)
      }
    }

    // ── Overview bypass: non-first-message hajj/umrah overview request ───────────
    // For first messages, the bypass runs inside the firstMessageQuestion block below.
    // Here we handle subsequent messages asking for an overview, so the AI never
    // composes the list — it only provides a one-line intro, then code appends the
    // pre-built overview message.
    if (totalMsgCount > 1 && prebuiltCatalog) {
      const ovMonth = detectUmrahMonth(text)
      const isHajjOv  = detectHajjOverviewIntent(text) && !detectFullDetailsIntent(text) &&
                        !!prebuiltCatalog.hajjOverviewMessage
      const isUmrahOv = !!ovMonth && !!prebuiltCatalog.umrahMonthMessages?.[ovMonth]

      if (isHajjOv || isUmrahOv) {
        this.fullDetailsMap.delete(conv.id)
        const firstName = knownCustomerName?.split(/\s+/)[0]
        const intro = firstName ? `تمام يا أستاذ ${firstName} اتفضل` : `اتفضل يافندم`
        await saveAssistantMessage(this.prisma, conv.id, intro)
        const parts: string[] = [intro]

        if (isHajjOv) {
          const ovMsg = prebuiltCatalog.hajjOverviewMessage + '\n\n' + HAJJ_OV_DISCLAIMER
          this.overviewMap.set(conv.id, { orderedDetails: prebuiltCatalog.hajjOverviewDetails })
          await saveAssistantMessage(this.prisma, conv.id, ovMsg)
          parts.push(ovMsg)
          console.log(`HAJJ_OV_BYPASS → ${phone} programs=${prebuiltCatalog.hajjOverviewDetails.length}`)
        } else if (isUmrahOv && ovMonth) {
          const ovMsg = prebuiltCatalog.umrahMonthMessages[ovMonth]
          await saveAssistantMessage(this.prisma, conv.id, ovMsg)
          parts.push(ovMsg)
          console.log(`UMRAH_OV_BYPASS → ${phone} month=${ovMonth}`)
        }

        return parts.length === 1 ? parts[0] : parts
      }
    }

    // First-message overview bypass: zero AI calls — intro from code, prebuilt message appended
    if (totalMsgCount === 1 && containsFirstMessageQuestion(text) && prebuiltCatalog) {
      const firstMsgUmrahMonth = detectUmrahMonth(text)
      const isHajjOvFirst = detectHajjOverviewIntent(text) && !detectFullDetailsIntent(text)
        && !!prebuiltCatalog.hajjOverviewMessage
      const isUmrahOvFirst = !!firstMsgUmrahMonth && !!prebuiltCatalog.umrahMonthMessages?.[firstMsgUmrahMonth]

      if (isHajjOvFirst || isUmrahOvFirst) {
        this.fullDetailsMap.delete(conv.id)
        const firstName = knownCustomerName?.split(/\s+/)[0]
        const intro = firstName ? `تمام يا أستاذ ${firstName} اتفضل` : `اتفضل يافندم`
        await saveAssistantMessage(this.prisma, conv.id, intro)
        const parts: string[] = [intro]

        if (isHajjOvFirst) {
          const ovMsg = prebuiltCatalog.hajjOverviewMessage + '\n\n' + HAJJ_OV_DISCLAIMER
          this.overviewMap.set(conv.id, { orderedDetails: prebuiltCatalog.hajjOverviewDetails })
          await saveAssistantMessage(this.prisma, conv.id, ovMsg)
          parts.push(ovMsg)
          console.log(`HAJJ_OV_ZERO_AI → ${phone} programs=${prebuiltCatalog.hajjOverviewDetails.length}`)
        } else if (firstMsgUmrahMonth) {
          const ovMsg = prebuiltCatalog.umrahMonthMessages[firstMsgUmrahMonth]
          await saveAssistantMessage(this.prisma, conv.id, ovMsg)
          parts.push(ovMsg)
          console.log(`UMRAH_OV_ZERO_AI_FIRST → ${phone} month=${firstMsgUmrahMonth}`)
        }

        return parts.length === 1 ? parts[0] : parts
      }
    }

    let rawAIReply = AI_ERROR_REPLY
    let aiCostUSD = 0
    try {
      const r = await getAgentReply(history, company.name, packages, aiPrompt, waPhone, company.industry, returningCustomer, knownCustomerName, companyFAQs, knownLeadFacts, prebuiltCatalog)
      rawAIReply = r.reply
      aiCostUSD = r.costUSD
    } catch (err) {
      if (err instanceof ApiCreditsExhaustedError) await handleAICreditsExhausted(this.prisma, companyId)
    }

    if (rawAIReply === AI_ERROR_REPLY) {
      const fc = (this.aiFailureCount.get(conv.id) ?? 0) + 1
      this.aiFailureCount.set(conv.id, fc)
      if (fc >= 2) {
        await this.prisma.conversation.update({
          where: { id: conv.id },
          data: { needsSalesContact: true, salesAlertReason: 'تكرار أخطاء الذكاء الاصطناعي' },
        })
        this.aiFailureCount.delete(conv.id)
        console.log(`AI_FAILURE_ESCALATED → ${phone} (${fc} consecutive failures)`)
        return ''
      }
      await saveAssistantMessage(this.prisma, conv.id, rawAIReply)
      console.log(`AI_FAILURE_1 → ${phone} (failure count: ${fc})`)
      return rawAIReply
    }

    this.aiFailureCount.delete(conv.id)
    writeCostRecord(this.prisma, companyId, conv.id, aiCostUSD)
    const reply = applyHajjDateDisclaimer(rawAIReply)

    await saveAssistantMessage(this.prisma, conv.id, reply)

    // Non-blocking: log deferral events for analytics
    if (DEFERRAL_PHRASES.some(p => reply.includes(p))) {
      this.prisma.agentInsight.create({
        data: { companyId, conversationId: conv.id, type: 'deferred_question', content: text },
      }).catch(e => console.error('AgentInsight write error:', e))
    }

    // Run extractLeadData on msg 1-2 (capture name early), every 3rd message,
    // or whenever the customer's message contains a booking keyword.
    const msgCount = totalMsgCount; // total msgs in DB (not history.length, which is capped at 10)
    const hasBookingSignal = BOOKING_KEYWORDS.some(kw => text.includes(kw));
    const runExtract = msgCount <= 2 || msgCount % 8 === 0 || hasBookingSignal;
    console.log(`EXTRACT: msg=${msgCount} run=${runExtract} (booking=${hasBookingSignal} mod5=${msgCount % 5 === 0})`);

    let extracted: Partial<LeadData> = {}
    let score = 0
    if (runExtract) {
      try {
        const extractResult = await extractLeadData([...history, { role: 'assistant', content: reply }])
        extracted = extractResult.data
      } catch (err) {
        if (err instanceof ApiCreditsExhaustedError) await handleAICreditsExhausted(this.prisma, companyId)
      }
      score = calculateScore(extracted)
      try {
        if (conv.leadId) await this.prisma.lead.update({
          where: { id: conv.leadId },
          data: {
            ...(extracted.name && !knownCustomerName && { name: extracted.name }),
            ...(extracted.packageType && { packageType: extracted.packageType }),
            ...(extracted.groupSize && { groupSize: extracted.groupSize }),
            ...(extracted.budget && { budget: extracted.budget }),
            ...(extracted.travelDate && { travelDate: extracted.travelDate }),
            ...(extracted.companionNote && { companionNote: extracted.companionNote }),
            score,
            isHot: score >= 70,
            status: score >= 70 ? LeadStatus.HOT : LeadStatus.CONTACTED,
          },
        })
      } catch (err) {
        console.error(`DB_ERROR lead.update leadId=${conv.leadId} companyId=${companyId}`, err)
      }
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

      // First-message question: send an immediate answer after the welcome without waiting for name
      if (totalMsgCount === 1 && containsFirstMessageQuestion(text)) {
        const umrahMonth = detectUmrahMonth(text)

        // ── Hajj overview bypass: send pre-built overview, no second AI call ──────
        if (detectHajjOverviewIntent(text) && !detectFullDetailsIntent(text) &&
            prebuiltCatalog?.hajjOverviewMessage) {
          this.fullDetailsMap.delete(conv.id)
          const ovMsg = prebuiltCatalog.hajjOverviewMessage + '\n\n' + HAJJ_OV_DISCLAIMER
          this.overviewMap.set(conv.id, { orderedDetails: prebuiltCatalog.hajjOverviewDetails })
          await saveAssistantMessage(this.prisma, conv.id, ovMsg)
          console.log(`HAJJ_OV_FIRST → ${phone} programs=${prebuiltCatalog.hajjOverviewDetails.length}`)
          return [reply, ovMsg]
        }

        // ── Umrah month bypass: send pre-built month message, no second AI call ──
        if (umrahMonth && prebuiltCatalog?.umrahMonthMessages?.[umrahMonth]) {
          const ovMsg = prebuiltCatalog.umrahMonthMessages[umrahMonth]
          await saveAssistantMessage(this.prisma, conv.id, ovMsg)
          console.log(`UMRAH_OV_FIRST → ${phone} month=${umrahMonth}`)
          return [reply, ovMsg]
        }

        // ── Generic overview: second AI call for other service/price questions ────
        const secondHistory = [
          { role: 'user' as const, content: text },
          { role: 'assistant' as const, content: reply },
          { role: 'user' as const, content: `اعرضلي نظرة عامة مختصرة على كل البرامج المتاحة — اسم البرنامج والسعر للفرد في سطر واحد لكل برنامج — بدون تفاصيل زيادة` },
        ]
        const overviewInstr = '[تعليمات إلزامية: اعرض الآن نظرة عامة مختصرة على كل البرامج المتاحة — اسم البرنامج + السعر للفرد في سطر واحد — ممنوع تأجيل العرض أو طلب اسم أو عدد — البرامج ذات السعر الخاص تُدرج حرفاً بـ"سعر خاص — للتواصل مع المبيعات" ولا تُحذف — اجمعهم بشكل طبيعي بعد العرض — اختم بـ: "تحب تفاصيل برنامج معين ولا أعرضلك تفاصيل كل البرامج؟"]'
        const secondAiPrompt = aiPrompt ? `${aiPrompt}\n\n${overviewInstr}` : overviewInstr
        let secondReply = ''
        let secondCost = 0
        try {
          const r2 = await getAgentReply(secondHistory, company.name, packages, secondAiPrompt, waPhone, company.industry, returningCustomer, knownCustomerName, companyFAQs, knownLeadFacts, prebuiltCatalog)
          secondReply = r2.reply
          secondCost = r2.costUSD
        } catch (err) {
          if (err instanceof ApiCreditsExhaustedError) await handleAICreditsExhausted(this.prisma, companyId)
        }
        if (secondReply && secondReply !== AI_ERROR_REPLY) {
          const secondCleaned = applyHajjDateDisclaimer(secondReply)
          await saveAssistantMessage(this.prisma, conv.id, secondCleaned)
          writeCostRecord(this.prisma, companyId, conv.id, secondCost)
          console.log(`FIRST_MSG_QUESTION_ANSWER → ${phone}`)
          return [reply, secondCleaned]
        }
      }

      return reply
    }

    // Handoff: booking confirmed — start branch-first flow
    // If booking flow already in progress (AI self-handoff edge case), send short ack
    if (conv.bookingStage !== 'NONE') {
      const ack = 'تمام يافندم، زميلنا هيتواصل معك في أقرب وقت إن شاء الله'
      await saveAssistantMessage(this.prisma, conv.id, ack)
      return ack
    }

    const leadForBooking = await this.prisma.lead.findFirst({
      where: { companyId, phone },
      select: { governorate: true },
    })
    const knownGov = leadForBooking?.governorate ?? null

    let bookingMsg: string
    let newStage: string

    if (knownGov) {
      bookingMsg = `تمام يافندم! بناءً على موقعك في ${knownGov} — أقرب فرع ليك هو:\n${branchMessage(knownGov)}\n\nهتيجي للفرع لإتمام الحجز؟`
      newStage = 'AWAITING_BRANCH_CONFIRM'
    } else {
      bookingMsg = 'تمام يافندم! عشان نوصلك لأقرب فرع ليك — حضرتك من أنهي محافظة؟'
      newStage = 'AWAITING_GOVERNORATE'
    }

    await this.prisma.conversation.update({
      where: { id: conv.id },
      data: {
        status: ConvStatus.NEEDS_HUMAN,
        agentMode: 'HUMAN',
        agentNotes: `${reason} | Score: ${score}/100`,
        handoffMessageSent: true,
        bookingStage: newStage,
      },
    })
    await saveAssistantMessage(this.prisma, conv.id, bookingMsg)
    // First booking flow trigger → promote lead to PENDING_PAYMENT
    if (conv.leadId) await this.prisma.lead.update({
      where: { id: conv.leadId },
      data: { status: LeadStatus.PENDING_PAYMENT, isHot: true },
    })
    console.log(`BOOKING_FLOW → ${phone} stage=${newStage} | Score: ${score} | ${reason}`)
    return bookingMsg
  }

  // Generates one AI reply for an existing conversation without creating a duplicate
  // USER message — used by the dashboard "take over with AI reply" flow.
  async triggerAIReply(convId: string): Promise<{
    reply: string; phone: string; waToken: string | null; waPhoneId: string | null
  }> {
    const empty = { reply: '', phone: '', waToken: null, waPhoneId: null }
    const conv = await this.prisma.conversation.findUnique({
      where: { id: convId },
      select: { id: true, phone: true, companyId: true, leadId: true },
    })
    if (!conv) return empty

    const company = await this.prisma.company.findUnique({ where: { id: conv.companyId } })
    if (!company || !company.isActive) return { ...empty, phone: conv.phone }

    const freshMessages = await this.prisma.message.findMany({
      where: { conversationId: convId },
      orderBy: { createdAt: 'desc' },
      take: 10,
    })
    const history = freshMessages.reverse().map(m => ({
      role: m.role === 'USER' ? 'user' : 'assistant',
      content: m.content,
    }))

    let knownCustomerName: string | undefined
    let knownLeadFacts: LeadFacts | undefined
    if (conv.leadId) {
      const lead = await this.prisma.lead.findUnique({
        where: { id: conv.leadId },
        select: { name: true, packageType: true, groupSize: true, travelDate: true, budget: true, companionNote: true },
      })
      if (lead?.name) knownCustomerName = lead.name
      if (lead && (lead.packageType || lead.groupSize != null || lead.travelDate || lead.budget || lead.companionNote)) {
        const companionInThisConv = companionConfirmedInHistory(freshMessages)
        const monthInThisConv = travelDateConfirmedInHistory(freshMessages)
        knownLeadFacts = {
          packageType: lead.packageType,
          budget: lead.budget,
          travelDate:    monthInThisConv    ? lead.travelDate    : undefined,
          groupSize:     companionInThisConv ? lead.groupSize     : undefined,
          companionNote: companionInThisConv ? lead.companionNote : undefined,
        }
      }
    }

    const packages = company.packages ?? ''
    const aiPrompt = company.aiPrompt ?? ''
    const waPhone  = company.phone ?? company.ownerPhone ?? ''
    const faqs = await this.getCompanyFAQ(conv.companyId)
    const prebuiltCatalogTrigger = await this.getPrebuiltCatalog(conv.companyId, company.name)

    let rawTriggerReply = AI_ERROR_REPLY
    try {
      const r = await getAgentReply(history, company.name, packages, aiPrompt, waPhone, company.industry, undefined, knownCustomerName, faqs, knownLeadFacts, prebuiltCatalogTrigger)
      rawTriggerReply = r.reply
      writeCostRecord(this.prisma, conv.companyId, convId, r.costUSD)
    } catch (err) {
      if (err instanceof ApiCreditsExhaustedError) await handleAICreditsExhausted(this.prisma, conv.companyId)
    }
    const reply = applyHajjDateDisclaimer(rawTriggerReply)

    await saveAssistantMessage(this.prisma, convId, reply)
    console.log(`MANUAL_AI_REPLY → conv=${convId} phone=${conv.phone}`)

    return { reply, phone: conv.phone, waToken: company.waToken, waPhoneId: company.waPhoneId }
  }
}
