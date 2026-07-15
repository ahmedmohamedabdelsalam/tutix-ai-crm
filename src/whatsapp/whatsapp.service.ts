import { Injectable } from '@nestjs/common'
import { toArabicIndic } from '../utils/arabic-numerals'
import { PrismaService } from '../prisma/prisma.service'
import { ConvStatus, FollowUpStatus, LeadStatus } from '@prisma/client'
import { getAgentReply, extractLeadData, calculateScore, shouldHandoff, LeadData, LeadFacts, PrebuiltCatalog, ApiCreditsExhaustedError, AI_ERROR_REPLY, BOOKING_KEYWORDS } from '../agent/agent.service'
import { splitIntoMessages } from './message-splitter'
import { applyHajjDateDisclaimer } from './hajj-date-disclaimer'
import { companionConfirmedInHistory, travelDateConfirmedInHistory } from './lead-fact-guards'
import { detectOnlinePayment, detectFarFromBranch, detectVisitConfirm } from './booking-stage-detectors'
import { getGovFromText, branchMessage } from './branch-lookup'
import { containsFirstMessageQuestion, detectUmrahMonth, detectUmrahLevel, detectFullDetailsIntent, detectContinueResponse, detectHajjOverviewIntent, detectHajjCategoryReply, detectNumberReply, detectUmrahOverviewIntent } from './intent-detectors'

import { detectFollowUpIntent, clampToWindow, DEFERRAL_PHRASES } from './follow-up-scheduler'
import { handleAICreditsExhausted, writeCostRecord } from './ai-cost-helpers'
import { saveAssistantMessage, completeBookingAlert } from './message-persistence'
import { getCompanyFAQ } from './faq-cache'
import { incrementAIFailure, resetAIFailure } from './ai-failure-tracker'
import { getPrebuiltCatalog } from './catalog-loader'
import { fullDetailsMap, overviewMap, categoryQuestionMap } from './conversation-state'
import { HAJJ_OV_DISCLAIMER } from '../agent/prompts/dynamic-catalog-builder'

// Injected ONLY into the POST-HANDOFF AI path (after booking confirmed, before sales takes over).
// Keeps official-price answers normal; defers any negotiation/discount request to sales.
const POST_HANDOFF_NEGOTIATION_INSTR =
  'لو العميل طلب خصم أو أقل سعر أو أرخص أو تخفيض أو سأل "ينفع أقل" أو "ممكن تنزّل" أو "آخر سعر" — ' +
  'لا تقتبس سعراً منخفضاً ولا توعد بأي خصم. ' +
  'قل فقط: "زميلنا المختص هيتواصل معك قريباً ويقدملك أحسن عرض إن شاء الله." ' +
  'الأسعار الرسمية والأسئلة العادية — جاوب عليها بشكل طبيعي.'


@Injectable()
export class WhatsAppService {
  constructor(private prisma: PrismaService) {}





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
          const ovMonthEsc      = detectUmrahMonth(text)
          const umrahLevelEsc   = detectUmrahLevel(text)
          const hajjOvIntentEsc = detectHajjOverviewIntent(text)
          const isUmrahOvEsc    = ovMonthEsc !== null
          const isUmrahAllOvEsc = !ovMonthEsc && detectUmrahOverviewIntent(text)
          const isTopicChange   = hajjOvIntentEsc !== null || isUmrahOvEsc || isUmrahAllOvEsc

          if (isTopicChange) {
            await this.prisma.conversation.update({ where: { id: conv.id }, data: { bookingStage: 'NONE' } })
            fullDetailsMap.delete(conv.id)
            const prebuiltCatalogEsc = await getPrebuiltCatalog(this.prisma, companyId, company.name)
            if (prebuiltCatalogEsc) {
              if (hajjOvIntentEsc !== null) {
                if (hajjOvIntentEsc === 'GENERIC' && prebuiltCatalogEsc.hajjCategoryQuestion) {
                  categoryQuestionMap.set(conv.id, true)
                  await saveAssistantMessage(this.prisma, conv.id, prebuiltCatalogEsc.hajjCategoryQuestion)
                  console.log(`BOOKING_ESC HAJJ_CAT_Q → ${phone}`)
                  return prebuiltCatalogEsc.hajjCategoryQuestion
                }
                const catMsgEsc     = hajjOvIntentEsc === 'ECONOMY' ? prebuiltCatalogEsc.hajjEconomyPrograms : prebuiltCatalogEsc.hajjFiveStarPrograms
                const catDetailsEsc = hajjOvIntentEsc === 'ECONOMY' ? prebuiltCatalogEsc.hajjEconomyDetails  : prebuiltCatalogEsc.hajjFiveStarDetails
                if (catMsgEsc) {
                  overviewMap.set(conv.id, { orderedDetails: catDetailsEsc })
                  await saveAssistantMessage(this.prisma, conv.id, catMsgEsc)
                  console.log(`BOOKING_ESC HAJJ_OV → ${phone} cat=${hajjOvIntentEsc} programs=${catDetailsEsc.length}`)
                  return catMsgEsc
                }
              }
              if (isUmrahOvEsc && ovMonthEsc && prebuiltCatalogEsc.umrahMonthMessages?.[ovMonthEsc]) {
                const firstName = knownCustomerName?.split(/\s+/)[0]
                const intro = firstName ? `تمام يا أستاذ ${firstName} اتفضل` : `اتفضل يافندم`
                await saveAssistantMessage(this.prisma, conv.id, intro)
                overviewMap.set(conv.id, { orderedDetails: prebuiltCatalogEsc.umrahMonthDetails[ovMonthEsc] })
                const filteredMsgEsc = umrahLevelEsc ? prebuiltCatalogEsc.umrahMonthLevelMessages?.[ovMonthEsc]?.[umrahLevelEsc] : undefined
                if (umrahLevelEsc && !filteredMsgEsc) {
                  const fallback = `مش عندنا برامج ${umrahLevelEsc} في ${ovMonthEsc} — اتفضل كل برامج الشهر:`
                  const fullMsg = prebuiltCatalogEsc.umrahMonthMessages[ovMonthEsc]
                  await saveAssistantMessage(this.prisma, conv.id, fallback)
                  await saveAssistantMessage(this.prisma, conv.id, fullMsg)
                  console.log(`BOOKING_ESC UMRAH_OV_NO_LEVEL → ${phone} month=${ovMonthEsc} level=${umrahLevelEsc}`)
                  return [intro, fallback, fullMsg]
                }
                const ovMsg = filteredMsgEsc ?? prebuiltCatalogEsc.umrahMonthMessages[ovMonthEsc]
                await saveAssistantMessage(this.prisma, conv.id, ovMsg)
                console.log(`BOOKING_ESC UMRAH_OV → ${phone} month=${ovMonthEsc}${umrahLevelEsc ? ` level=${umrahLevelEsc}` : ''}`)
                return [intro, ovMsg]
              }
              if (isUmrahAllOvEsc && prebuiltCatalogEsc.umrahAllMonthsMessage) {
                const firstName = knownCustomerName?.split(/\s+/)[0]
                const intro = firstName ? `تمام يا أستاذ ${firstName} اتفضل` : `اتفضل يافندم`
                await saveAssistantMessage(this.prisma, conv.id, intro)
                const ovMsg = prebuiltCatalogEsc.umrahAllMonthsMessage
                overviewMap.set(conv.id, { orderedDetails: prebuiltCatalogEsc.umrahAllMonthsDetails })
                await saveAssistantMessage(this.prisma, conv.id, ovMsg)
                console.log(`BOOKING_ESC UMRAH_ALL_OV → ${phone}`)
                return [intro, ovMsg]
              }
            }
            // prebuiltCatalog unavailable or no bypass path matched → fall through to AI pipeline
          } else {
            const askAgain = 'معلش يافندم، مفهمتش — حضرتك من أنهي محافظة بالضبط؟'
            await saveAssistantMessage(this.prisma, conv.id, askAgain)
            return askAgain
          }
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
        const baseAiPromptNH = company.aiPrompt ?? ''
        const aiPromptNH = baseAiPromptNH
          ? `${baseAiPromptNH}\n\n${POST_HANDOFF_NEGOTIATION_INSTR}`
          : POST_HANDOFF_NEGOTIATION_INSTR
        // Suppress phone in CTA once handoff message already sent — prevents repeat
        const waPhoneNH  = conv.handoffMessageSent ? '' : (company.phone ?? company.ownerPhone ?? '')
        const faqsNH = await getCompanyFAQ(this.prisma, companyId)
        const prebuiltCatalogNH = await getPrebuiltCatalog(this.prisma, companyId, company.name)
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

    const companyFAQs = await getCompanyFAQ(this.prisma, companyId)
    const prebuiltCatalog = await getPrebuiltCatalog(this.prisma, companyId, company.name)

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
      const fdState = fullDetailsMap.get(conv.id)
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

        if (isLast) fullDetailsMap.delete(conv.id)
        else fullDetailsMap.set(conv.id, { offset: nextOffset, total })

        await saveAssistantMessage(this.prisma, conv.id, fdReply)
        console.log(`FD_CHUNK → ${phone} offset=${offset}..${nextOffset - 1}/${total} isLast=${isLast}`)
        return fdReply
      }

      if (fdState && !isContinue) {
        fullDetailsMap.delete(conv.id)
      }
    }

    // ── Overview state: number-reply handler (all message counts) ────────────────
    // When a customer replies with a number after seeing the Hajj overview, deliver
    // that program's full details directly from the pre-rendered array — no AI involved.
    if (prebuiltCatalog) {
      const ovState = overviewMap.get(conv.id)
      if (ovState) {
        const n = detectNumberReply(text)
        if (n !== null && n >= 1 && n <= ovState.orderedDetails.length) {
          const detail = applyHajjDateDisclaimer(ovState.orderedDetails[n - 1])
          overviewMap.delete(conv.id)
          await saveAssistantMessage(this.prisma, conv.id, detail)
          console.log(`OV_NUMBER → ${phone} n=${n} → program detail sent`)
          return detail
        }
        // Topic changed — clear overview state and let normal AI handle it
        overviewMap.delete(conv.id)
      }
    }

    // ── Category-reply handler: customer replied to the Hajj category question ──
    if (prebuiltCatalog && categoryQuestionMap.has(conv.id)) {
      const catReply = detectHajjCategoryReply(text)
      if (catReply !== null) {
        categoryQuestionMap.delete(conv.id)
        fullDetailsMap.delete(conv.id)
        const catMsg     = catReply === 'ECONOMY' ? prebuiltCatalog.hajjEconomyPrograms : prebuiltCatalog.hajjFiveStarPrograms
        const catDetails = catReply === 'ECONOMY' ? prebuiltCatalog.hajjEconomyDetails  : prebuiltCatalog.hajjFiveStarDetails
        if (catMsg) {
          overviewMap.set(conv.id, { orderedDetails: catDetails })
          await saveAssistantMessage(this.prisma, conv.id, catMsg)
          console.log(`HAJJ_CAT_REPLY → ${phone} cat=${catReply} programs=${catDetails.length}`)
          return catMsg
        }
      }
      // Topic changed — clear category state and let AI handle it
      categoryQuestionMap.delete(conv.id)
    }

    // ── Overview bypass: non-first-message hajj/umrah overview request ───────────
    // For first messages, the bypass runs inside the firstMessageQuestion block below.
    // Here we handle subsequent messages asking for an overview, so the AI never
    // composes the list — it only provides a one-line intro, then code appends the
    // pre-built overview message.
    if (totalMsgCount > 1 && prebuiltCatalog) {
      const ovMonth      = detectUmrahMonth(text)
      const umrahLevel   = detectUmrahLevel(text)
      const hajjOvIntent = detectHajjOverviewIntent(text)
      const isUmrahOv    = !!ovMonth && !!prebuiltCatalog.umrahMonthMessages?.[ovMonth]
      const isUmrahAllOv = !ovMonth && detectUmrahOverviewIntent(text) && !!prebuiltCatalog.umrahAllMonthsMessage

      // Hajj category-aware bypass — handled separately (no intro message)
      if (hajjOvIntent !== null && !detectFullDetailsIntent(text)) {
        fullDetailsMap.delete(conv.id)
        if (hajjOvIntent === 'GENERIC' && prebuiltCatalog.hajjCategoryQuestion) {
          categoryQuestionMap.set(conv.id, true)
          await saveAssistantMessage(this.prisma, conv.id, prebuiltCatalog.hajjCategoryQuestion)
          console.log(`HAJJ_CAT_Q_BYPASS → ${phone}`)
          return prebuiltCatalog.hajjCategoryQuestion
        }
        const catMsg     = hajjOvIntent === 'ECONOMY' ? prebuiltCatalog.hajjEconomyPrograms : prebuiltCatalog.hajjFiveStarPrograms
        const catDetails = hajjOvIntent === 'ECONOMY' ? prebuiltCatalog.hajjEconomyDetails  : prebuiltCatalog.hajjFiveStarDetails
        if (catMsg) {
          overviewMap.set(conv.id, { orderedDetails: catDetails })
          await saveAssistantMessage(this.prisma, conv.id, catMsg)
          console.log(`HAJJ_OV_BYPASS → ${phone} cat=${hajjOvIntent} programs=${catDetails.length}`)
          return catMsg
        }
      }

      // Umrah overviews — existing logic unchanged
      if (isUmrahOv || isUmrahAllOv) {
        fullDetailsMap.delete(conv.id)
        const firstName = knownCustomerName?.split(/\s+/)[0]
        const intro = firstName ? `تمام يا أستاذ ${firstName} اتفضل` : `اتفضل يافندم`
        await saveAssistantMessage(this.prisma, conv.id, intro)
        const parts: string[] = [intro]

        if (isUmrahOv && ovMonth) {
          overviewMap.set(conv.id, { orderedDetails: prebuiltCatalog.umrahMonthDetails[ovMonth] })
          const filteredMsg = umrahLevel ? prebuiltCatalog.umrahMonthLevelMessages?.[ovMonth]?.[umrahLevel] : undefined
          if (umrahLevel && !filteredMsg) {
            const fallback = `مش عندنا برامج ${umrahLevel} في ${ovMonth} — اتفضل كل برامج الشهر:`
            const fullMsg = prebuiltCatalog.umrahMonthMessages[ovMonth]
            await saveAssistantMessage(this.prisma, conv.id, fallback)
            await saveAssistantMessage(this.prisma, conv.id, fullMsg)
            parts.push(fallback, fullMsg)
            console.log(`UMRAH_OV_BYPASS_NO_LEVEL → ${phone} month=${ovMonth} level=${umrahLevel}`)
          } else {
            const ovMsg = filteredMsg ?? prebuiltCatalog.umrahMonthMessages[ovMonth]
            await saveAssistantMessage(this.prisma, conv.id, ovMsg)
            parts.push(ovMsg)
            console.log(`UMRAH_OV_BYPASS → ${phone} month=${ovMonth}${umrahLevel ? ` level=${umrahLevel}` : ''} trips=${prebuiltCatalog.umrahMonthDetails[ovMonth].length}`)
          }
        } else if (isUmrahAllOv) {
          const ovMsg = prebuiltCatalog.umrahAllMonthsMessage
          overviewMap.set(conv.id, { orderedDetails: prebuiltCatalog.umrahAllMonthsDetails })
          await saveAssistantMessage(this.prisma, conv.id, ovMsg)
          parts.push(ovMsg)
          console.log(`UMRAH_ALL_OV_BYPASS → ${phone} total=${prebuiltCatalog.umrahAllMonthsDetails.length}`)
        }

        return parts.length === 1 ? parts[0] : parts
      }
    }

    // First-message overview bypass: zero AI calls — intro from code, prebuilt message appended
    if (totalMsgCount === 1 && containsFirstMessageQuestion(text) && prebuiltCatalog) {
      const firstMsgUmrahMonth  = detectUmrahMonth(text)
      const firstMsgUmrahLevel  = detectUmrahLevel(text)
      const hajjOvIntentFirst   = detectHajjOverviewIntent(text)
      const isUmrahOvFirst      = !!firstMsgUmrahMonth && !!prebuiltCatalog.umrahMonthMessages?.[firstMsgUmrahMonth]
      const isUmrahAllOvFirst   = !firstMsgUmrahMonth && detectUmrahOverviewIntent(text) && !!prebuiltCatalog.umrahAllMonthsMessage

      // Hajj category-aware bypass — no intro, no AI
      if (hajjOvIntentFirst !== null && !detectFullDetailsIntent(text)) {
        fullDetailsMap.delete(conv.id)
        if (hajjOvIntentFirst === 'GENERIC' && prebuiltCatalog.hajjCategoryQuestion) {
          categoryQuestionMap.set(conv.id, true)
          await saveAssistantMessage(this.prisma, conv.id, prebuiltCatalog.hajjCategoryQuestion)
          console.log(`HAJJ_CAT_Q_ZERO_AI → ${phone}`)
          return prebuiltCatalog.hajjCategoryQuestion
        }
        const catMsg     = hajjOvIntentFirst === 'ECONOMY' ? prebuiltCatalog.hajjEconomyPrograms : prebuiltCatalog.hajjFiveStarPrograms
        const catDetails = hajjOvIntentFirst === 'ECONOMY' ? prebuiltCatalog.hajjEconomyDetails  : prebuiltCatalog.hajjFiveStarDetails
        if (catMsg) {
          overviewMap.set(conv.id, { orderedDetails: catDetails })
          await saveAssistantMessage(this.prisma, conv.id, catMsg)
          console.log(`HAJJ_OV_ZERO_AI → ${phone} cat=${hajjOvIntentFirst} programs=${catDetails.length}`)
          return catMsg
        }
      }

      // Umrah overviews — existing logic unchanged
      if (isUmrahOvFirst || isUmrahAllOvFirst) {
        fullDetailsMap.delete(conv.id)
        const firstName = knownCustomerName?.split(/\s+/)[0]
        const intro = firstName ? `تمام يا أستاذ ${firstName} اتفضل` : `اتفضل يافندم`
        await saveAssistantMessage(this.prisma, conv.id, intro)
        const parts: string[] = [intro]

        if (firstMsgUmrahMonth) {
          overviewMap.set(conv.id, { orderedDetails: prebuiltCatalog.umrahMonthDetails[firstMsgUmrahMonth] })
          const filteredMsgFirst = firstMsgUmrahLevel ? prebuiltCatalog.umrahMonthLevelMessages?.[firstMsgUmrahMonth]?.[firstMsgUmrahLevel] : undefined
          if (firstMsgUmrahLevel && !filteredMsgFirst) {
            const fallback = `مش عندنا برامج ${firstMsgUmrahLevel} في ${firstMsgUmrahMonth} — اتفضل كل برامج الشهر:`
            const fullMsg = prebuiltCatalog.umrahMonthMessages[firstMsgUmrahMonth]
            await saveAssistantMessage(this.prisma, conv.id, fallback)
            await saveAssistantMessage(this.prisma, conv.id, fullMsg)
            parts.push(fallback, fullMsg)
            console.log(`UMRAH_OV_ZERO_AI_FIRST_NO_LEVEL → ${phone} month=${firstMsgUmrahMonth} level=${firstMsgUmrahLevel}`)
          } else {
            const ovMsg = filteredMsgFirst ?? prebuiltCatalog.umrahMonthMessages[firstMsgUmrahMonth]
            await saveAssistantMessage(this.prisma, conv.id, ovMsg)
            parts.push(ovMsg)
            console.log(`UMRAH_OV_ZERO_AI_FIRST → ${phone} month=${firstMsgUmrahMonth}${firstMsgUmrahLevel ? ` level=${firstMsgUmrahLevel}` : ''} trips=${prebuiltCatalog.umrahMonthDetails[firstMsgUmrahMonth].length}`)
          }
        } else if (isUmrahAllOvFirst) {
          const ovMsg = prebuiltCatalog.umrahAllMonthsMessage
          overviewMap.set(conv.id, { orderedDetails: prebuiltCatalog.umrahAllMonthsDetails })
          await saveAssistantMessage(this.prisma, conv.id, ovMsg)
          parts.push(ovMsg)
          console.log(`UMRAH_ALL_OV_ZERO_AI_FIRST → ${phone} total=${prebuiltCatalog.umrahAllMonthsDetails.length}`)
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
      const fc = incrementAIFailure(conv.id)
      if (fc >= 2) {
        await this.prisma.conversation.update({
          where: { id: conv.id },
          data: { needsSalesContact: true, salesAlertReason: 'تكرار أخطاء الذكاء الاصطناعي' },
        })
        resetAIFailure(conv.id)
        console.log(`AI_FAILURE_ESCALATED → ${phone} (${fc} consecutive failures)`)
        return ''
      }
      await saveAssistantMessage(this.prisma, conv.id, rawAIReply)
      console.log(`AI_FAILURE_1 → ${phone} (failure count: ${fc})`)
      return rawAIReply
    }

    resetAIFailure(conv.id)
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

        // ── Hajj category-aware bypass: after AI welcome, append prebuilt Hajj message ─
        if (!detectFullDetailsIntent(text)) {
          const hajjOvIntentPost = detectHajjOverviewIntent(text)
          if (hajjOvIntentPost !== null) {
            fullDetailsMap.delete(conv.id)
            if (hajjOvIntentPost === 'GENERIC' && prebuiltCatalog?.hajjCategoryQuestion) {
              categoryQuestionMap.set(conv.id, true)
              await saveAssistantMessage(this.prisma, conv.id, prebuiltCatalog.hajjCategoryQuestion)
              console.log(`HAJJ_CAT_Q_FIRST → ${phone}`)
              return [reply, prebuiltCatalog.hajjCategoryQuestion]
            }
            const catMsg     = hajjOvIntentPost === 'ECONOMY' ? prebuiltCatalog?.hajjEconomyPrograms : prebuiltCatalog?.hajjFiveStarPrograms
            const catDetails = hajjOvIntentPost === 'ECONOMY' ? prebuiltCatalog?.hajjEconomyDetails  : prebuiltCatalog?.hajjFiveStarDetails
            if (catMsg && catDetails) {
              overviewMap.set(conv.id, { orderedDetails: catDetails })
              await saveAssistantMessage(this.prisma, conv.id, catMsg)
              console.log(`HAJJ_OV_FIRST → ${phone} cat=${hajjOvIntentPost} programs=${catDetails.length}`)
              return [reply, catMsg]
            }
          }
        }

        // ── Umrah month bypass: send pre-built month message, no second AI call ──
        if (umrahMonth && prebuiltCatalog?.umrahMonthMessages?.[umrahMonth]) {
          const ovMsg = prebuiltCatalog.umrahMonthMessages[umrahMonth]
          overviewMap.set(conv.id, { orderedDetails: prebuiltCatalog.umrahMonthDetails[umrahMonth] })
          await saveAssistantMessage(this.prisma, conv.id, ovMsg)
          console.log(`UMRAH_OV_FIRST → ${phone} month=${umrahMonth} trips=${prebuiltCatalog.umrahMonthDetails[umrahMonth].length}`)
          return [reply, ovMsg]
        }

        // ── Umrah all-months bypass: general umrah query with no specific month ──
        if (!umrahMonth && detectUmrahOverviewIntent(text) && prebuiltCatalog?.umrahAllMonthsMessage) {
          const ovMsg = prebuiltCatalog.umrahAllMonthsMessage
          overviewMap.set(conv.id, { orderedDetails: prebuiltCatalog.umrahAllMonthsDetails })
          await saveAssistantMessage(this.prisma, conv.id, ovMsg)
          console.log(`UMRAH_ALL_OV_FIRST → ${phone} total=${prebuiltCatalog.umrahAllMonthsDetails.length}`)
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
  async triggerAIReply(convId: string, expectedCompanyId: string): Promise<{
    reply: string; phone: string; waToken: string | null; waPhoneId: string | null
  }> {
    const empty = { reply: '', phone: '', waToken: null, waPhoneId: null }
    const conv = await this.prisma.conversation.findUnique({
      where: { id: convId },
      select: { id: true, phone: true, companyId: true, leadId: true },
    })
    if (!conv) return empty
    if (conv.companyId !== expectedCompanyId) {
      console.warn(`TRIGGER_AI_REPLY_BLOCKED: convId=${convId} belongs to company=${conv.companyId}, caller claimed=${expectedCompanyId}`)
      return empty
    }

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
    const faqs = await getCompanyFAQ(this.prisma, conv.companyId)
    const prebuiltCatalogTrigger = await getPrebuiltCatalog(this.prisma, conv.companyId, company.name)

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
