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
import { containsFirstMessageQuestion, detectUmrahMonth, detectUmrahLevel, detectFullDetailsIntent, detectContinueResponse, detectHajjOverviewIntent, detectHajjCategoryReply, detectNumberReply, detectUmrahOverviewIntent, detectCTAMessage, detectDurationDays, detectPriceIntent, detectScheduleIntent, detectFlightIntent, detectInstallmentIntent, detectHotelDistanceIntent, detectNearestTripIntent } from './intent-detectors'

import { detectFollowUpIntent, clampToWindow, DEFERRAL_PHRASES } from './follow-up-scheduler'
import { handleAICreditsExhausted, writeCostRecord } from './ai-cost-helpers'
import { saveAssistantMessage, completeBookingAlert } from './message-persistence'
import { getCompanyFAQ } from './faq-cache'
import { incrementAIFailure, resetAIFailure } from './ai-failure-tracker'
import { getPrebuiltCatalog } from './catalog-loader'
import { isAIConfigActive } from './ai-config-cache'
import { fullDetailsMap, overviewMap, categoryQuestionMap } from './conversation-state'
import { HAJJ_OV_DISCLAIMER, groupUmrahTrips, buildScheduleItinerary, buildFlightReply } from '../agent/prompts/dynamic-catalog-builder'
import { lookupHotelEntry } from '../agent/prompts/hajj-umrah-hotels'
import { RawTrip } from './conversation-state'

// Arabic month name → calendar number (used when populating rawTrips on overviewMap)
const MONTH_TO_NUM: Record<string, number> = {
  'يوليو': 7, 'أغسطس': 8, 'سبتمبر': 9, 'أكتوبر': 10, 'نوفمبر': 11,
  'ديسمبر': 12, 'يناير': 1, 'فبراير': 2, 'مارس': 3, 'أبريل': 4, 'مايو': 5, 'يونيو': 6,
}

// Injected ONLY into the POST-HANDOFF AI path (after booking confirmed, before sales takes over).
// Keeps official-price answers normal; defers any negotiation/discount request to sales.
const POST_HANDOFF_NEGOTIATION_INSTR =
  'لو العميل طلب خصم أو أقل سعر أو أرخص أو تخفيض أو سأل "ينفع أقل" أو "ممكن تنزّل" أو "آخر سعر" — ' +
  'لا تقتبس سعراً منخفضاً ولا توعد بأي خصم. ' +
  'قل فقط: "زميلنا المختص هيتواصل معك قريباً ويقدملك أحسن عرض إن شاء الله." ' +
  'الأسعار الرسمية والأسئلة العادية — جاوب عليها بشكل طبيعي.'

function countNameAsksInHistory(messages: any[]): number {
  const patterns = ['تشرفنا باسم', 'اسم حضرتك', 'باسم حضرتك', 'ممكن اعرف اسم']
  return messages.filter(m => m.role === 'ASSISTANT' && patterns.some(p => m.content.includes(p))).length
}

function hasNameComplaint(text: string): boolean {
  return ['بتطلبوا الاسم', 'الاسم كتير', 'بتطلب الاسم', 'ليه بتسأل عن الاسم'].some(p => text.includes(p))
}

@Injectable()
export class WhatsAppService {
  constructor(private prisma: PrismaService) {}





  async handleMessage(companyId: string, phone: string, text: string, source = 'direct', referralData?: object | null, simulate = false): Promise<string | string[]> {
    // simulate=true: accepted ONLY from /webhook/test — never passed by the real Meta webhook path.
    // Gates are bypassed so catalog bypasses can be tested while AI stays fully locked.
    // Assistant replies are NOT persisted to DB in this mode (prevents watchdog false-alarms
    // and keeps the test conversation clean). sendWhatsAppMessage is structurally unreachable
    // from handleMessage; the /webhook/test endpoint never calls it either.
    const persistReply = simulate
      ? async (_convId: string, _content: string): Promise<any> => {}
      : (convId: string, content: string) => saveAssistantMessage(this.prisma, convId, content)

    const company = await this.prisma.company.findUnique({ where: { id: companyId } })
    if (!company || !company.isActive) return ''

    // Company-wide AI kill switch (CompanyAIConfig.isActive). Cached 60s.
    // Checked AFTER this point so message persistence always runs first.
    const aiActive = await isAIConfigActive(this.prisma, companyId)

    const msgInclude = { messages: { orderBy: { createdAt: 'asc' as const }, take: -30 } }

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

    // Webhook dedup guard: Meta sometimes delivers the same event twice (voice transcription, retry).
    // If the latest stored USER message is identical to incoming text and < 8s old, skip processing.
    if (conv?.messages) {
      const lastUserMsg = [...(conv.messages as any[])].reverse().find(m => m.role === 'USER')
      if (lastUserMsg && lastUserMsg.content === text) {
        const ageMs = Date.now() - new Date(lastUserMsg.createdAt).getTime()
        if (ageMs < 8000) {
          console.log(`DEDUP_GUARD → ${phone} duplicate within ${ageMs}ms, skipping`)
          return ''
        }
      }
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

        // Schema default is 'HUMAN' — any creation path that omits agentMode fails silent.
        // This is the only place where agentMode='AI' is written for new conversations.
        // RE-ENABLE AFTER PAUSE (both locks must be cleared deliberately):
        //   Step 1 — set CompanyAIConfig.isActive=true via the dashboard kill-switch toggle
        //   Step 2 — conversations must reach agentMode='AI' (created here, or bulk-flipped)
        //   Either lock alone keeps AI fully silent.
        conv = await this.prisma.conversation.create({
          data: {
            companyId,
            phone,
            leadId: lead.id,
            status: ConvStatus.AI_HANDLING,
            agentMode: (!aiActive || hasWonLead) ? 'HUMAN' : 'AI',
          },
          include: msgInclude,
        })

        if (hasWonLead) {
          await this.prisma.message.create({
            data: { conversationId: conv.id, role: 'USER', content: text },
          })
          if (aiActive) {
            const welcomeBack = 'أهلاً بعودتك يافندم نورتنا تاني سيتواصل معك أحد متخصصينا قريباً إن شاء الله'
            await persistReply(conv.id,welcomeBack)
            await this.prisma.conversation.update({
              where: { id: conv.id },
              data: {
                status: ConvStatus.NEEDS_HUMAN,
                agentNotes: 'عميل عائد - تسليم فوري للمبيعات',
              },
            })
            console.log(`RETURNING CUSTOMER → ${phone} — message saved for sales, not auto-sent`)
            return ''
          }
          await this.prisma.conversation.update({
            where: { id: conv.id },
            data: { status: ConvStatus.NEEDS_HUMAN, agentNotes: 'عميل عائد - تسليم فوري للمبيعات', updatedAt: new Date() },
          })
          console.log(`RETURNING CUSTOMER (AI OFF) → ${phone}`)
          return ''
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
    const lockedByManual = new Set<string>()
    if (conv.leadId) {
      const lead = await this.prisma.lead.findUnique({
        where: { id: conv.leadId },
        select: { name: true, packageType: true, groupSize: true, travelDate: true, budget: true, companionNote: true, manualFields: true },
      })
      if (!knownCustomerName && lead?.name) knownCustomerName = lead.name
      if (lead?.manualFields) {
        for (const f of lead.manualFields.split(',')) { if (f.trim()) lockedByManual.add(f.trim()) }
      }
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

    if (simulate) console.log(`[SIMULATE] phone=${phone} — bypassing HUMAN/STATUS/KILL_SWITCH gates, replies returned via HTTP only`)

    // ── PART 2: HUMAN mode — save message ───────────────────
    if (!simulate && conv.agentMode === 'HUMAN') {
      await this.prisma.message.create({
        data: { conversationId: conv.id, role: 'USER', content: text },
      })
      await this.prisma.conversation.update({
        where: { id: conv.id },
        data: { updatedAt: new Date() },
      })

      // agentMode=HUMAN: unconditional silence — message saved for sales inbox, no automated reply.
      console.log(`HUMAN_MODE (${conv.status}) — ${phone} message saved, no reply`)
      return ''
    }

    // ── AI mode but conversation already handed off ───────────
    if (!simulate && conv.status !== ConvStatus.AI_HANDLING) {
      await this.prisma.message.create({
        data: { conversationId: conv.id, role: 'USER', content: text },
      })
      await this.prisma.conversation.update({
        where: { id: conv.id },
        data: { updatedAt: new Date() },
      })
      return ''
    }

    // ── Full AI pipeline ─────────────────────────────────────
    await this.prisma.message.create({
      data: { conversationId: conv.id, role: 'USER', content: text },
    })

    // Company-wide AI kill switch: message saved for inbox, no automated reply
    if (!simulate && !aiActive) {
      await this.prisma.conversation.update({
        where: { id: conv.id },
        data: { updatedAt: new Date() },
      })
      console.log(`AI_KILL_SWITCH OFF — ${phone} message saved, no AI reply`)
      return ''
    }

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

    // Name-ask ceiling: stop asking for name after 2 asks or if customer complained
    const nameAsks = countNameAsksInHistory((conv.messages as any[]) ?? [])
    const effectiveAiPrompt = (!knownCustomerName && (nameAsks >= 2 || hasNameComplaint(text)))
      ? '⛔ لا تسأل عن اسم العميل — تابع المحادثة بدون طلب الاسم' + (aiPrompt ? '\n\n' + aiPrompt : '')
      : aiPrompt

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
      await persistReply(conv.id,clarify)
      console.log(`SHORT-MSG GUARD → ${phone} sent "${trimmedText}"`)
      return clarify
    }

    // ── CTA handler: Meta CTA button tap or ad-referral click (first message only) ─
    if (totalMsgCount === 1 && prebuiltCatalog?.ctaReply && detectCTAMessage(text, source, referralData as any)) {
      await persistReply(conv.id, prebuiltCatalog.ctaReply)
      console.log(`CTA_HANDLER → ${phone} source=${source}`)
      return prebuiltCatalog.ctaReply
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

        await persistReply(conv.id,fdReply)
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
    // Schedule or flight intent in the same message → deliver that view instead.
    if (prebuiltCatalog) {
      const ovState = overviewMap.get(conv.id)
      if (ovState) {
        const n = detectNumberReply(text)
        if (n !== null && n >= 1 && n <= ovState.orderedDetails.length) {
          const trip: RawTrip | undefined = ovState.rawTrips?.[n - 1]
          if (detectScheduleIntent(text) && trip) {
            const schedMsg = buildScheduleItinerary(trip.depISO, trip.retISO, trip.progs)
            overviewMap.delete(conv.id)
            await persistReply(conv.id, schedMsg)
            console.log(`SCHEDULE_WITH_NUMBER → ${phone} n=${n}`)
            return schedMsg
          }
          if (detectFlightIntent(text) && trip) {
            const flightMsg = buildFlightReply(trip.depISO, trip.retISO, trip.progs)
            overviewMap.delete(conv.id)
            await persistReply(conv.id, flightMsg)
            console.log(`FLIGHT_WITH_NUMBER → ${phone} n=${n}`)
            return flightMsg
          }
          const detail = applyHajjDateDisclaimer(ovState.orderedDetails[n - 1])
          overviewMap.delete(conv.id)
          await persistReply(conv.id,detail)
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
        const catMsg     = catReply === 'ECONOMY' ? prebuiltCatalog.hajjEconomyPrograms
                         : catReply === 'FIVE_STAR' ? prebuiltCatalog.hajjFiveStarPrograms
                         : prebuiltCatalog.hajjKadanPrograms
        const catDetails = catReply === 'ECONOMY' ? prebuiltCatalog.hajjEconomyDetails
                         : catReply === 'FIVE_STAR' ? prebuiltCatalog.hajjFiveStarDetails
                         : prebuiltCatalog.hajjKadanDetails
        if (catMsg) {
          overviewMap.set(conv.id, { orderedDetails: catDetails })
          await persistReply(conv.id,catMsg)
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
      const isUmrahAllOv = !ovMonth && detectUmrahOverviewIntent(text) && !!prebuiltCatalog.umrahAllMonthsMessage && !detectHotelDistanceIntent(text)

      // Hajj category-aware bypass — handled separately (no intro message)
      // Flight queries pass through so the flight handler can answer per-program.
      if (hajjOvIntent !== null && !detectFullDetailsIntent(text) && !detectFlightIntent(text)) {
        fullDetailsMap.delete(conv.id)
        if (hajjOvIntent === 'GENERIC' && prebuiltCatalog.hajjCategoryQuestion) {
          categoryQuestionMap.set(conv.id, true)
          await persistReply(conv.id,prebuiltCatalog.hajjCategoryQuestion)
          console.log(`HAJJ_CAT_Q_BYPASS → ${phone}`)
          return prebuiltCatalog.hajjCategoryQuestion
        }
        const catMsg     = hajjOvIntent === 'ECONOMY' ? prebuiltCatalog.hajjEconomyPrograms
                         : hajjOvIntent === 'FIVE_STAR' ? prebuiltCatalog.hajjFiveStarPrograms
                         : prebuiltCatalog.hajjKadanPrograms
        const catDetails = hajjOvIntent === 'ECONOMY' ? prebuiltCatalog.hajjEconomyDetails
                         : hajjOvIntent === 'FIVE_STAR' ? prebuiltCatalog.hajjFiveStarDetails
                         : prebuiltCatalog.hajjKadanDetails
        if (catMsg) {
          overviewMap.set(conv.id, { orderedDetails: catDetails })
          await persistReply(conv.id,catMsg)
          console.log(`HAJJ_OV_BYPASS → ${phone} cat=${hajjOvIntent} programs=${catDetails.length}`)
          return catMsg
        }
      }

      // Umrah overviews — rawTrips populated for schedule/flight handlers
      if (isUmrahOv || isUmrahAllOv) {
        fullDetailsMap.delete(conv.id)
        const firstName = knownCustomerName?.split(/\s+/)[0]
        const intro = firstName ? `تمام يا أستاذ ${firstName} اتفضل` : `اتفضل يافندم`
        await persistReply(conv.id,intro)
        const parts: string[] = [intro]

        if (isUmrahOv && ovMonth) {
          const monthNum   = MONTH_TO_NUM[ovMonth]
          const rawTrips   = groupUmrahTrips(prebuiltCatalog.rawUmrahPrograms, { month: monthNum })
          overviewMap.set(conv.id, { orderedDetails: prebuiltCatalog.umrahMonthDetails[ovMonth], rawTrips })
          const filteredMsg = umrahLevel ? prebuiltCatalog.umrahMonthLevelMessages?.[ovMonth]?.[umrahLevel] : undefined
          if (umrahLevel && !filteredMsg) {
            const fallback = `مش عندنا برامج ${umrahLevel} في ${ovMonth} — اتفضل كل برامج الشهر:`
            const fullMsg = prebuiltCatalog.umrahMonthMessages[ovMonth]
            await persistReply(conv.id,fallback)
            await persistReply(conv.id,fullMsg)
            parts.push(fallback, fullMsg)
            console.log(`UMRAH_OV_BYPASS_NO_LEVEL → ${phone} month=${ovMonth} level=${umrahLevel}`)
          } else {
            const ovMsg = filteredMsg ?? prebuiltCatalog.umrahMonthMessages[ovMonth]
            await persistReply(conv.id,ovMsg)
            parts.push(ovMsg)
            console.log(`UMRAH_OV_BYPASS → ${phone} month=${ovMonth}${umrahLevel ? ` level=${umrahLevel}` : ''} trips=${prebuiltCatalog.umrahMonthDetails[ovMonth].length}`)
          }
        } else if (isUmrahAllOv) {
          const rawTrips = groupUmrahTrips(prebuiltCatalog.rawUmrahPrograms)
          const ovMsg = prebuiltCatalog.umrahAllMonthsMessage
          overviewMap.set(conv.id, { orderedDetails: prebuiltCatalog.umrahAllMonthsDetails, rawTrips })
          await persistReply(conv.id,ovMsg)
          parts.push(ovMsg)
          console.log(`UMRAH_ALL_OV_BYPASS → ${phone} total=${prebuiltCatalog.umrahAllMonthsDetails.length}`)
        }

        return parts.length === 1 ? parts[0] : parts
      }

      // Month unavailable: a specific month was detected but has no programs
      if (ovMonth && !prebuiltCatalog.umrahMonthMessages?.[ovMonth] && detectHajjOverviewIntent(text) === null) {
        const unavailMsg = `برامج ${ovMonth} لسه بتتجهز — لما تبقى متاحة هنعلمك فوراً إن شاء الله 🤍\nتحب تبعتلنا اسمك ورقم تليفونك عشان نتواصل معك أول ما تتاح البرامج؟`
        if (conv.leadId) {
          await this.prisma.lead.update({ where: { id: conv.leadId }, data: { notes: `اهتمام: ${ovMonth}` } })
        }
        await persistReply(conv.id, unavailMsg)
        console.log(`MONTH_UNAVAILABLE → ${phone} month=${ovMonth}`)
        return unavailMsg
      }
    }

    // ── Duration handler: customer specifies trip length in days (any message count) ─
    if (prebuiltCatalog) {
      const durationDays = detectDurationDays(text)
      if (durationDays !== null) {
        if (prebuiltCatalog.umrahDurationMessages[durationDays]) {
          const requestedLevel = detectUmrahLevel(text)
          const rawTrips = groupUmrahTrips(prebuiltCatalog.rawUmrahPrograms, { durationDays })

          // W1: if customer requested a specific level, check if it exists for this duration
          let levelMismatch = ''
          if (requestedLevel && prebuiltCatalog.rawUmrahPrograms) {
            const levelExists = prebuiltCatalog.rawUmrahPrograms.some(p => {
              const dep: string = p.departureDate ?? ''
              const ret: string = p.returnDate ?? ''
              if (!dep || !ret || !/^\d{4}-\d{2}-\d{2}$/.test(dep)) return false
              const days = Math.round(
                (new Date(ret + 'T00:00:00Z').getTime() - new Date(dep + 'T00:00:00Z').getTime()) / 86400000,
              ) + 1
              if (days !== durationDays) return false
              const name: string = p.name ?? ''
              if (requestedLevel === 'خمس نجوم') return name.includes('خمس نجوم') || name.includes('فاخر')
              if (requestedLevel === 'اقتصادي متميز') return name.includes('اقتصادي متميز')
              if (requestedLevel === 'اقتصادي') return name.includes('اقتصادي') && !name.includes('اقتصادي متميز')
              return false
            })
            if (!levelExists) {
              const durWord = durationDays >= 3 && durationDays <= 10 ? 'أيام' : 'يوم'
              levelMismatch = `مش عندنا برامج ${requestedLevel} لمدة ${toArabicIndic(durationDays)} ${durWord} — اتفضل المتاح:\n\n`
            }
          }

          const msg = levelMismatch + prebuiltCatalog.umrahDurationMessages[durationDays]
          overviewMap.set(conv.id, { orderedDetails: prebuiltCatalog.umrahDurationDetails[durationDays], rawTrips })
          await persistReply(conv.id, 'اتفضل يافندم')
          await persistReply(conv.id, msg)
          console.log(`DURATION_BYPASS → ${phone} days=${durationDays}${requestedLevel ? ` level=${requestedLevel} mismatch=${!!levelMismatch}` : ''}`)
          return ['اتفضل يافندم', msg]
        } else if (prebuiltCatalog.durationPivotMsg) {
          await persistReply(conv.id, prebuiltCatalog.durationPivotMsg)
          console.log(`DURATION_NOT_FOUND → ${phone} days=${durationDays} → pivot`)
          return prebuiltCatalog.durationPivotMsg
        }
      }
    }

    // First-message overview bypass: zero AI calls — intro from code, prebuilt message appended
    if (totalMsgCount === 1 && containsFirstMessageQuestion(text) && prebuiltCatalog) {
      const firstMsgUmrahMonth  = detectUmrahMonth(text)
      const firstMsgUmrahLevel  = detectUmrahLevel(text)
      const hajjOvIntentFirst   = detectHajjOverviewIntent(text)
      const isUmrahOvFirst      = !!firstMsgUmrahMonth && !!prebuiltCatalog.umrahMonthMessages?.[firstMsgUmrahMonth]
      const isUmrahAllOvFirst   = !firstMsgUmrahMonth && detectUmrahOverviewIntent(text) && !!prebuiltCatalog.umrahAllMonthsMessage && !detectHotelDistanceIntent(text)

      // Hajj category-aware bypass — no intro, no AI
      // Flight queries pass through so the flight handler can answer per-program.
      if (hajjOvIntentFirst !== null && !detectFullDetailsIntent(text) && !detectFlightIntent(text)) {
        fullDetailsMap.delete(conv.id)
        if (hajjOvIntentFirst === 'GENERIC' && prebuiltCatalog.hajjCategoryQuestion) {
          categoryQuestionMap.set(conv.id, true)
          await persistReply(conv.id,prebuiltCatalog.hajjCategoryQuestion)
          console.log(`HAJJ_CAT_Q_ZERO_AI → ${phone}`)
          return prebuiltCatalog.hajjCategoryQuestion
        }
        const catMsg     = hajjOvIntentFirst === 'ECONOMY' ? prebuiltCatalog.hajjEconomyPrograms
                         : hajjOvIntentFirst === 'FIVE_STAR' ? prebuiltCatalog.hajjFiveStarPrograms
                         : prebuiltCatalog.hajjKadanPrograms
        const catDetails = hajjOvIntentFirst === 'ECONOMY' ? prebuiltCatalog.hajjEconomyDetails
                         : hajjOvIntentFirst === 'FIVE_STAR' ? prebuiltCatalog.hajjFiveStarDetails
                         : prebuiltCatalog.hajjKadanDetails
        if (catMsg) {
          overviewMap.set(conv.id, { orderedDetails: catDetails })
          await persistReply(conv.id,catMsg)
          console.log(`HAJJ_OV_ZERO_AI → ${phone} cat=${hajjOvIntentFirst} programs=${catDetails.length}`)
          return catMsg
        }
      }

      // Umrah overviews — rawTrips populated for schedule/flight handlers
      if (isUmrahOvFirst || isUmrahAllOvFirst) {
        fullDetailsMap.delete(conv.id)
        const firstName = knownCustomerName?.split(/\s+/)[0]
        const intro = firstName ? `تمام يا أستاذ ${firstName} اتفضل` : `اتفضل يافندم`
        await persistReply(conv.id,intro)
        const parts: string[] = [intro]

        if (firstMsgUmrahMonth) {
          const monthNum  = MONTH_TO_NUM[firstMsgUmrahMonth]
          const rawTrips  = groupUmrahTrips(prebuiltCatalog.rawUmrahPrograms, { month: monthNum })
          overviewMap.set(conv.id, { orderedDetails: prebuiltCatalog.umrahMonthDetails[firstMsgUmrahMonth], rawTrips })
          const filteredMsgFirst = firstMsgUmrahLevel ? prebuiltCatalog.umrahMonthLevelMessages?.[firstMsgUmrahMonth]?.[firstMsgUmrahLevel] : undefined
          if (firstMsgUmrahLevel && !filteredMsgFirst) {
            const fallback = `مش عندنا برامج ${firstMsgUmrahLevel} في ${firstMsgUmrahMonth} — اتفضل كل برامج الشهر:`
            const fullMsg = prebuiltCatalog.umrahMonthMessages[firstMsgUmrahMonth]
            await persistReply(conv.id,fallback)
            await persistReply(conv.id,fullMsg)
            parts.push(fallback, fullMsg)
            console.log(`UMRAH_OV_ZERO_AI_FIRST_NO_LEVEL → ${phone} month=${firstMsgUmrahMonth} level=${firstMsgUmrahLevel}`)
          } else {
            const ovMsg = filteredMsgFirst ?? prebuiltCatalog.umrahMonthMessages[firstMsgUmrahMonth]
            await persistReply(conv.id,ovMsg)
            parts.push(ovMsg)
            console.log(`UMRAH_OV_ZERO_AI_FIRST → ${phone} month=${firstMsgUmrahMonth}${firstMsgUmrahLevel ? ` level=${firstMsgUmrahLevel}` : ''} trips=${prebuiltCatalog.umrahMonthDetails[firstMsgUmrahMonth].length}`)
          }
        } else if (isUmrahAllOvFirst) {
          const rawTrips = groupUmrahTrips(prebuiltCatalog.rawUmrahPrograms)
          const ovMsg = prebuiltCatalog.umrahAllMonthsMessage
          overviewMap.set(conv.id, { orderedDetails: prebuiltCatalog.umrahAllMonthsDetails, rawTrips })
          await persistReply(conv.id,ovMsg)
          parts.push(ovMsg)
          console.log(`UMRAH_ALL_OV_ZERO_AI_FIRST → ${phone} total=${prebuiltCatalog.umrahAllMonthsDetails.length}`)
        }

        return parts.length === 1 ? parts[0] : parts
      }

      // Month unavailable in first message
      if (firstMsgUmrahMonth && !prebuiltCatalog.umrahMonthMessages?.[firstMsgUmrahMonth] && hajjOvIntentFirst === null) {
        const unavailMsg = `برامج ${firstMsgUmrahMonth} لسه بتتجهز — لما تبقى متاحة هنعلمك فوراً إن شاء الله 🤍\nتحب تبعتلنا اسمك ورقم تليفونك عشان نتواصل معك أول ما تتاح البرامج؟`
        if (conv.leadId) {
          await this.prisma.lead.update({ where: { id: conv.leadId }, data: { notes: `اهتمام: ${firstMsgUmrahMonth}` } })
        }
        await persistReply(conv.id, unavailMsg)
        console.log(`MONTH_UNAVAILABLE_FIRST → ${phone} month=${firstMsgUmrahMonth}`)
        return unavailMsg
      }
    }

    // ── Schedule handler: if overview was already shown → ask for trip number
    //                       if no overview shown yet → show overview first (B2)
    if (prebuiltCatalog && detectScheduleIntent(text) && detectHajjOverviewIntent(text) === null) {
      if (!overviewMap.has(conv.id) && prebuiltCatalog.umrahAllMonthsMessage) {
        const rawTrips = groupUmrahTrips(prebuiltCatalog.rawUmrahPrograms)
        overviewMap.set(conv.id, { orderedDetails: prebuiltCatalog.umrahAllMonthsDetails, rawTrips })
        const schedAsk = 'ابعت رقم الرحلة اللي يناسبك وهبعتلك الجدول كامل 🤍'
        await persistReply(conv.id, 'اتفضل يافندم')
        await persistReply(conv.id, prebuiltCatalog.umrahAllMonthsMessage)
        await persistReply(conv.id, schedAsk)
        console.log(`SCHEDULE_SHOW_OV → ${phone}`)
        return ['اتفضل يافندم', prebuiltCatalog.umrahAllMonthsMessage, schedAsk]
      }
      const noCtxMsg = 'ابعت رقم البرنامج اللي حضرتك مهتم بيه وهبعتلك الجدول الكامل 🤍'
      await persistReply(conv.id, noCtxMsg)
      console.log(`SCHEDULE_NO_CTX → ${phone}`)
      return noCtxMsg
    }

    // ── Flight handler: if overview was already shown → ask for trip number
    //                     if no overview shown yet → show overview first (B2)
    if (prebuiltCatalog && detectFlightIntent(text)) {
      const isHajjQ = detectHajjOverviewIntent(text) !== null
      if (isHajjQ) {
        const hajjFlightMsg = 'يافندم برامج الحج بتاعتنا الأسعار بدون تذكرة الطيران أو العبّارة — التذكرة بتُحسب منفصلة حسب توفرها وقت الحجز.\n\nعندك سؤال تاني عن برامج الحج؟ 🤍'
        await persistReply(conv.id, hajjFlightMsg)
        console.log(`FLIGHT_HANDLER → ${phone} hajj=true`)
        return hajjFlightMsg
      }
      if (!overviewMap.has(conv.id) && prebuiltCatalog.umrahAllMonthsMessage) {
        const rawTrips = groupUmrahTrips(prebuiltCatalog.rawUmrahPrograms)
        overviewMap.set(conv.id, { orderedDetails: prebuiltCatalog.umrahAllMonthsDetails, rawTrips })
        const flightAsk = 'ابعت رقم الرحلة اللي بتستفسر عنها وهبعتلك تفاصيل الطيران 🤍'
        await persistReply(conv.id, 'اتفضل يافندم')
        await persistReply(conv.id, prebuiltCatalog.umrahAllMonthsMessage)
        await persistReply(conv.id, flightAsk)
        console.log(`FLIGHT_SHOW_OV → ${phone}`)
        return ['اتفضل يافندم', prebuiltCatalog.umrahAllMonthsMessage, flightAsk]
      }
      const flightMsg = 'ابعت رقم الرحلة المحددة اللي بتستفسر عنها وهبعتلك تفاصيل الطيران بتاعها 🤍'
      await persistReply(conv.id, flightMsg)
      console.log(`FLIGHT_HANDLER → ${phone} hajj=false`)
      return flightMsg
    }

    // ── Installment handler: reply with stored policy; skip if policy not configured ─
    if (prebuiltCatalog?.installmentReply && detectInstallmentIntent(text)) {
      await persistReply(conv.id, prebuiltCatalog.installmentReply)
      console.log(`INSTALLMENT_HANDLER → ${phone}`)
      return prebuiltCatalog.installmentReply
    }

    // ── Nearest trip handler: "أقرب رحلة عمرة امتى" → earliest departure from catalog ─
    if (prebuiltCatalog && detectNearestTripIntent(text) && prebuiltCatalog.rawUmrahPrograms?.length) {
      const trips = groupUmrahTrips(prebuiltCatalog.rawUmrahPrograms)
      if (trips.length > 0 && prebuiltCatalog.umrahAllMonthsDetails?.length > 0) {
        const nearest = trips[0]
        const detail = prebuiltCatalog.umrahAllMonthsDetails[0]
        overviewMap.set(conv.id, { orderedDetails: prebuiltCatalog.umrahAllMonthsDetails, rawTrips: trips })
        const closingQ = '\n\nعندك سؤال تاني عن الرحلة؟ 🤍'
        await persistReply(conv.id, 'اتفضل يافندم — أقرب رحلة عمرة عندنا:')
        await persistReply(conv.id, detail + closingQ)
        console.log(`NEAREST_TRIP_HANDLER → ${phone} dep=${nearest.depISO}`)
        return ['اتفضل يافندم — أقرب رحلة عمرة عندنا:', detail + closingQ]
      }
    }

    // ── Hotel distance handler: reply with stored distance from hotelList; no AI ──
    if (prebuiltCatalog?.hotelList?.length && detectHotelDistanceIntent(text)) {
      const hotel = lookupHotelEntry(text, prebuiltCatalog.hotelList)
      if (hotel) {
        const starsTag = hotel.stars ? ` (${hotel.stars})` : ''
        let distReply: string
        if (hotel.distance) {
          distReply = `*${hotel.name}*${starsTag}:\n· المسافة: ${hotel.distance}\n· الموقع: ${hotel.location ?? ''}\n\nعندك سؤال تاني عن الفندق؟ 🤍`
        } else {
          distReply = `*${hotel.name}*${starsTag}:\n· الموقع: ${hotel.location ?? ''}\n\nللمسافة الدقيقة — تواصل مع الفريق لتأكيد التفاصيل. عندك سؤال تاني؟ 🤍`
        }
        await persistReply(conv.id, distReply)
        console.log(`HOTEL_DIST_HANDLER → ${phone} hotel=${hotel.name} hasDist=${!!hotel.distance}`)
        return distReply
      }
      // Distance intent but no hotel name in message — ask which hotel
      const askHotel = 'أي فندق بتستفسر عن مسافته؟ ابعت اسم الفندق وهبعتلك التفاصيل 🤍'
      await persistReply(conv.id, askHotel)
      console.log(`HOTEL_DIST_ASK → ${phone}`)
      return askHotel
    }

    // ── Price-pivot handler: price intent without duration or month — pivot to duration question ─
    if (prebuiltCatalog?.durationPivotMsg && detectPriceIntent(text)
        && detectDurationDays(text) === null && detectUmrahMonth(text) === null
        && detectHajjOverviewIntent(text) === null) {
      await persistReply(conv.id, prebuiltCatalog.durationPivotMsg)
      console.log(`PRICE_PIVOT → ${phone}`)
      return prebuiltCatalog.durationPivotMsg
    }

    let rawAIReply = AI_ERROR_REPLY
    let aiCostUSD = 0
    try {
      const r = await getAgentReply(history, company.name, packages, effectiveAiPrompt, waPhone, company.industry, returningCustomer, knownCustomerName, companyFAQs, knownLeadFacts, prebuiltCatalog)
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
      await persistReply(conv.id,rawAIReply)
      console.log(`AI_FAILURE_1 → ${phone} (failure count: ${fc})`)
      return rawAIReply
    }

    resetAIFailure(conv.id)
    writeCostRecord(this.prisma, companyId, conv.id, aiCostUSD)
    const reply = applyHajjDateDisclaimer(rawAIReply)

    await persistReply(conv.id,reply)

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
            ...(extracted.name        && !knownCustomerName                    && !lockedByManual.has('name')         && { name: extracted.name }),
            ...(extracted.packageType && !lockedByManual.has('packageType')    && { packageType: extracted.packageType }),
            ...(extracted.groupSize   && !lockedByManual.has('groupSize')      && { groupSize: extracted.groupSize }),
            ...(extracted.budget      && !lockedByManual.has('budget')         && { budget: extracted.budget }),
            ...(extracted.travelDate  && !lockedByManual.has('travelDate')     && { travelDate: extracted.travelDate }),
            ...(extracted.companionNote && !lockedByManual.has('companionNote') && { companionNote: extracted.companionNote }),
            score,
            isHot: score >= 70,
            status: score >= 70 ? LeadStatus.HOT : LeadStatus.CONTACTED,
          },
        })
      } catch (err) {
        console.error(`DB_ERROR lead.update leadId=${conv.leadId} companyId=${companyId}`, err)
      }
    }

    const { yes, reason } = shouldHandoff(score, totalMsgCount, extracted, text)

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
              await persistReply(conv.id,prebuiltCatalog.hajjCategoryQuestion)
              console.log(`HAJJ_CAT_Q_FIRST → ${phone}`)
              return [reply, prebuiltCatalog.hajjCategoryQuestion]
            }
            const catMsg     = hajjOvIntentPost === 'ECONOMY' ? prebuiltCatalog?.hajjEconomyPrograms : prebuiltCatalog?.hajjFiveStarPrograms
            const catDetails = hajjOvIntentPost === 'ECONOMY' ? prebuiltCatalog?.hajjEconomyDetails  : prebuiltCatalog?.hajjFiveStarDetails
            if (catMsg && catDetails) {
              overviewMap.set(conv.id, { orderedDetails: catDetails })
              await persistReply(conv.id,catMsg)
              console.log(`HAJJ_OV_FIRST → ${phone} cat=${hajjOvIntentPost} programs=${catDetails.length}`)
              return [reply, catMsg]
            }
          }
        }

        // ── Umrah month bypass: send pre-built month message, no second AI call ──
        if (umrahMonth && prebuiltCatalog?.umrahMonthMessages?.[umrahMonth]) {
          const ovMsg = prebuiltCatalog.umrahMonthMessages[umrahMonth]
          overviewMap.set(conv.id, { orderedDetails: prebuiltCatalog.umrahMonthDetails[umrahMonth] })
          await persistReply(conv.id,ovMsg)
          console.log(`UMRAH_OV_FIRST → ${phone} month=${umrahMonth} trips=${prebuiltCatalog.umrahMonthDetails[umrahMonth].length}`)
          return [reply, ovMsg]
        }

        // ── Umrah all-months bypass: general umrah query with no specific month ──
        if (!umrahMonth && detectUmrahOverviewIntent(text) && prebuiltCatalog?.umrahAllMonthsMessage) {
          const ovMsg = prebuiltCatalog.umrahAllMonthsMessage
          overviewMap.set(conv.id, { orderedDetails: prebuiltCatalog.umrahAllMonthsDetails })
          await persistReply(conv.id,ovMsg)
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
        const secondAiPrompt = effectiveAiPrompt ? `${effectiveAiPrompt}\n\n${overviewInstr}` : overviewInstr
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
          await persistReply(conv.id,secondCleaned)
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
      await persistReply(conv.id, ack)
      return simulate ? ack : ''  // saved for sales dashboard, never auto-sent (simulate: return for HTTP inspection)
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

    if (!simulate) {
      // Skip handoff writes in simulate mode: conv.agentMode must NOT be set to HUMAN
      // (would break subsequent simulate calls) and lead status must not be promoted.
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
      // First booking flow trigger → promote lead to PENDING_PAYMENT
      if (conv.leadId) await this.prisma.lead.update({
        where: { id: conv.leadId },
        data: { status: LeadStatus.PENDING_PAYMENT, isHot: true },
      })
    }
    await persistReply(conv.id, bookingMsg)
    console.log(`BOOKING_FLOW → ${phone} stage=${newStage} | Score: ${score} | ${reason}`)
    return simulate ? bookingMsg : ''  // saved for sales dashboard, never auto-sent (simulate: return for HTTP inspection)
  }

  // Generates one AI reply for an existing conversation without creating a duplicate
  // USER message — used by the dashboard "take over with AI reply" flow.
  async triggerAIReply(convId: string, expectedCompanyId: string): Promise<{
    reply: string; phone: string; waToken: string | null; waPhoneId: string | null; error?: string
  }> {
    const empty = { reply: '', phone: '', waToken: null, waPhoneId: null }
    const conv = await this.prisma.conversation.findUnique({
      where: { id: convId },
      select: { id: true, phone: true, companyId: true, leadId: true, agentMode: true },
    })
    if (!conv) return empty
    if (conv.companyId !== expectedCompanyId) {
      console.warn(`TRIGGER_AI_REPLY_BLOCKED: convId=${convId} belongs to company=${conv.companyId}, caller claimed=${expectedCompanyId}`)
      return empty
    }

    const company = await this.prisma.company.findUnique({ where: { id: conv.companyId } })
    if (!company || !company.isActive) return { ...empty, phone: conv.phone }

    if (!await isAIConfigActive(this.prisma, conv.companyId)) {
      console.log(`AI_KILL_SWITCH OFF (TRIGGER) — conv=${convId}`)
      return { ...empty, phone: conv.phone, error: 'الإيجنت متوقف حالياً' }
    }

    if (conv.agentMode === 'HUMAN') {
      console.log(`TRIGGER_AI_REPLY BLOCKED (HUMAN_MODE) — conv=${convId}`)
      return { ...empty, phone: conv.phone, error: 'الإيجنت متوقف حالياً' }
    }

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
