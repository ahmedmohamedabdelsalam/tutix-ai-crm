import { Injectable } from '@nestjs/common'
import { ARABIC_INDIC, CAIRO_OFFSET_MS, toArabicIndic } from '../utils/arabic-numerals'
import { PrismaService } from '../prisma/prisma.service'
import { ConvStatus, FollowUpStatus, LeadStatus } from '@prisma/client'
import { getAgentReply, extractLeadData, calculateScore, shouldHandoff, LeadData, LeadFacts, PrebuiltCatalog, ApiCreditsExhaustedError, AI_ERROR_REPLY, BOOKING_KEYWORDS } from '../agent/agent.service'
import { buildIndustryPromptFromDB } from '../agent/prompts/dynamic-catalog-builder'
import { splitIntoMessages } from './message-splitter'

// ── Branch mapping ───────────────────────────────────────────────────────────

const BRANCH_MAP: Array<[string[], string]> = [
  [
    ['الإسكندرية', 'البحيرة', 'مطروح'],
    'فرع الإسكندرية — شقة 2، الدور الأول، عمارة 4 البانسيون، عمارات أزهار السرايا، شارع فوزي معاذ، سموحة',
  ],
  [
    ['القاهرة', 'الجيزة', 'القليوبية', 'الإسماعيلية', 'السويس'],
    'فرع القاهرة — عمارة 18، شارع الطاقة، مشروع 27، مدينة نصر',
  ],
  [
    ['بورسعيد'],
    'وكيلنا في بورسعيد (أفيلابول) — مساكن الحزب الوطني ع33، بجوار استوديو محسن',
  ],
  [
    ['دمياط', 'الدقهلية', 'المنوفية', 'الغربية', 'الشرقية', 'كفر الشيخ'],
    'فرع دمياط الجديدة — المنطقة المركزية، شارع البنك الأهلي القديم',
  ],
]

const CAIRO_GOVS = new Set(['القاهرة', 'الجيزة', 'القليوبية', 'الإسماعيلية', 'السويس'])

const GOV_PATTERNS: Array<[RegExp, string]> = [
  [/إسكندرية|اسكندرية|أسكندرية|سكندرية/, 'الإسكندرية'],
  [/البحيرة|بحيرة/, 'البحيرة'],
  [/مطروح/, 'مطروح'],
  [/القاهرة|قاهرة/, 'القاهرة'],
  [/الجيزة|جيزة/, 'الجيزة'],
  [/القليوبية|قليوبية/, 'القليوبية'],
  [/دمياط/, 'دمياط'],
  [/بورسعيد/, 'بورسعيد'],
  [/الدقهلية|دقهلية/, 'الدقهلية'],
  [/المنوفية|منوفية/, 'المنوفية'],
  [/الغربية|غربية/, 'الغربية'],
  [/الشرقية|شرقية/, 'الشرقية'],
  [/كفر الشيخ|كفرالشيخ/, 'كفر الشيخ'],
  [/الإسماعيلية|اسماعيلية|إسماعيلية/, 'الإسماعيلية'],
  [/السويس|سويس/, 'السويس'],
  [/أسوان|اسوان/, 'أسوان'],
  [/الأقصر|اقصر|أقصر/, 'الأقصر'],
  [/سوهاج/, 'سوهاج'],
  [/أسيوط|اسيوط/, 'أسيوط'],
  [/قنا/, 'قنا'],
  [/المنيا|منيا/, 'المنيا'],
  [/بني سويف|بنى سويف/, 'بني سويف'],
  [/الفيوم|فيوم/, 'الفيوم'],
]

function getGovFromText(text: string): string | null {
  for (const [pat, gov] of GOV_PATTERNS) {
    if (pat.test(text)) return gov
  }
  return null
}

function getBranch(gov: string): string {
  for (const [govs, branch] of BRANCH_MAP) {
    if (govs.includes(gov)) return branch
  }
  return 'فرع القاهرة — عمارة 18، شارع الطاقة، مشروع 27، مدينة نصر'
}

function branchMessage(gov: string): string {
  const branch = getBranch(gov)
  const remoteSuffix = !CAIRO_GOVS.has(gov) && branch.startsWith('فرع القاهرة')
    ? '\n(أو تواصل مع زميلنا المختص لترتيب أنسب طريقة ليك)' : ''
  return `📍 ${branch}${remoteSuffix}`
}

function detectOnlinePayment(text: string): boolean {
  return /فودافون\s*كاش|إنستاباي|انستاباي|تحويل\s*بنكي|أونلاين|اونلاين|فيزا|محفظة/.test(text)
}

// Appends a provisional-date disclaimer whenever the reply mentions Hajj 1448H
// dates. The LLM strips "تقريباً" from catalog text, so this is enforced here.
function applyHajjDateDisclaimer(reply: string): string {
  const mentionsHajj1448 =
    reply.includes('ذي الحجة ١٤٤٨') ||
    (reply.includes('ذي الحجة') && /٢٠٢٧/.test(reply))
  if (!mentionsHajj1448) return reply
  const disclaimer =
    'ملاحظة: التواريخ الهجرية لبرامج الحج ١٤٤٨هـ تقديرية بناءً على الحساب الفلكي وسيُعلن الرسمي منها بعد رؤية الهلال قبل الموسم بأسابيع'
  return `${reply}\n\n${disclaimer}`
}

// Returns true only when the conversation's own messages mention companion or group context.
// Used to gate cross-session Lead facts (groupSize, companionNote) from being injected
// as "confirmed" context when the customer has said nothing about companions in this session.
export function companionConfirmedInHistory(messages: { content: string }[]): boolean {
  const text = messages.map(m => m.content).join(' ')
  return /والد|زوج|مراتي|مراته|أهل|معايا|أنا\s+و/.test(text)
}

// Returns true only when the conversation's own messages mention a travel month or date.
// Used to gate cross-session Lead.travelDate from being injected as "confirmed" context
// when the customer has not stated a month in this session.
export function travelDateConfirmedInHistory(messages: { content: string }[]): boolean {
  const text = messages.map(m => m.content).join(' ')
  return /يوليو|اغسطس|أغسطس|سبتمبر|اكتوبر|أكتوبر|نوفمبر|رمضان|مايو|يونيو|شهر/.test(text)
}

function detectFarFromBranch(text: string): boolean {
  return /بعيد|مش قادر|ما\s*أقدر|مش هينفع|مش ممكن|ما\s*ينفعش|بعد عني|مش عارف أجي/.test(text)
}

function detectVisitConfirm(text: string): boolean {
  return /تمام|هيجي|هجي|هنيجي|هنجي|موافق|طيب|أيوه|ايوه|اوكي|حاضر|هروح|هحضر|ماشي/.test(text)
}

// Returns true when the customer's first message contains a real question or service intent,
// so the AI can send an immediate answer after the welcome instead of waiting for a name.
// "هل" uses a lookbehind to avoid matching inside greetings like "أهلاً".
function containsFirstMessageQuestion(text: string): boolean {
  const QUESTION_SIGNALS = /عايز|محتاج|قولي|ممكن|أريد|اريد|كام|بكام|عندكم|فيه|ينفع|إيه|ايه|ما هو|(?<![ء-ي])هل|متى|فين|أسعار|اسعار|برامج|رحلة|رحلات/
  const SERVICE_SIGNALS  = /عمرة|حج|يوليو|أغسطس|سبتمبر|سعر|فندق|برنامج/
  return QUESTION_SIGNALS.test(text) || SERVICE_SIGNALS.test(text)
}

// Detects a specific umrah month in the customer message.
// Returns the Arabic month name as used in the month overview blocks (e.g. 'أغسطس').
function detectUmrahMonth(text: string): string | null {
  if (/يولي[وو]|يوليو/.test(text)) return 'يوليو'
  if (/اغسطس|أغسطس/.test(text)) return 'أغسطس'
  if (/سبتمبر/.test(text)) return 'سبتمبر'
  if (/اكتوبر|أكتوبر/.test(text)) return 'أكتوبر'
  if (/نوفمبر/.test(text)) return 'نوفمبر'
  return null
}

// Extracts just the trip lines for a specific month from the monthOverviews block.
function detectFullDetailsIntent(text: string): boolean {
  // Match requests for full program details even when modifier words are between keywords
  const hasAll = /كل/.test(text)
  const hasPrograms = /برامج|رحلات/.test(text)
  const hasDetails = /تفاصيل/.test(text)
  if (hasAll && hasPrograms && hasDetails) return true
  return /اعرضهم\s*كلهم|كله\s*بالتفص|تفاصيل\s*كل/.test(text)
}

function detectContinueResponse(text: string): boolean {
  // \b doesn't work with Arabic (non-ASCII = \W). Use optional trailing content instead.
  return /^(كمل|اكمل|كمّل|ايوه|أيوه|اه|أه|آه|نعم|تمام|ماشي)(\s.*)?$/.test(text.trim())
}

function detectHajjOverviewIntent(text: string): boolean {
  return /برامج\s*الحج|أسعار\s*الحج|اسعار\s*الحج|برامج\s*حج|عن\s*برامج\s*الحج/.test(text) ||
    (/حج/.test(text) && /برامج|اسعار|أسعار|قولي|اعرض|عايز\s*اعرف/.test(text))
}

function detectNumberReply(text: string): number | null {
  const t = text.trim()
  // Arabic-Indic single digit ١-٩
  const arMatch = t.match(/^([١٢٣٤٥٦٧٨٩])$/)
  if (arMatch) return '١٢٣٤٥٦٧٨٩'.indexOf(arMatch[1]) + 1
  // Western single digit 1-9
  const numMatch = t.match(/^([1-9])$/)
  if (numMatch) return parseInt(numMatch[1])
  // "رقم ٦" or "رقم 6"
  const raqmMatch = t.match(/رقم\s*([١٢٣٤٥٦٧٨٩]|[1-9])/)
  if (raqmMatch) {
    const c = raqmMatch[1]
    return '١٢٣٤٥٦٧٨٩'.includes(c) ? '١٢٣٤٥٦٧٨٩'.indexOf(c) + 1 : parseInt(c)
  }
  // Ordinals
  const ordinals: Record<string, number> = {
    'الأول': 1, 'الثاني': 2, 'الثالث': 3, 'الرابع': 4,
    'الخامس': 5, 'السادس': 6, 'السابع': 7, 'الثامن': 8, 'التاسع': 9,
  }
  for (const [word, n] of Object.entries(ordinals)) {
    if (t.includes(word)) return n
  }
  return null
}

// ── Follow-up scheduling utilities ──────────────────────────────────────────

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

  private async handleAICreditsExhausted(companyId: string): Promise<void> {
    console.error(`🔴 ANTHROPIC_CREDITS_EXHAUSTED — companyId=${companyId}`)
    this.prisma.systemNotification.create({
      data: {
        companyId,
        type: 'API_CREDITS_LOW',
        message: 'تنبيه عاجل: رصيد Anthropic API نفذ — النظام متوقف عن الرد على العملاء',
      },
    }).catch(e => console.error('SystemNotification create error:', e))
  }

  private writeCostRecord(companyId: string, conversationId: string, costUSD: number): void {
    if (costUSD <= 0) return
    this.prisma.agentInsight.create({
      data: {
        companyId,
        conversationId,
        type: 'api_cost',
        category: new Date().toISOString().slice(0, 10),
        content: costUSD.toFixed(6),
      },
    }).catch(e => console.error('AgentInsight cost write error:', e))
  }

  // Save each WhatsApp-split part as its own Message record so the dashboard
  // shows the same number of bubbles the customer sees on their phone.
  private async saveAssistantMessage(conversationId: string, content: string): Promise<void> {
    const parts = splitIntoMessages(content)
    const baseTs = new Date()
    for (let i = 0; i < parts.length; i++) {
      await this.prisma.message.create({
        data: {
          conversationId,
          role: 'ASSISTANT',
          content: parts[i],
          createdAt: new Date(baseTs.getTime() + i * 200),
        },
      })
    }
    // Bump conversation.updatedAt so the inbox list re-sorts by latest activity
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    })
  }

  private async completeBookingAlert(
    convId: string,
    companyId: string,
    phone: string,
    reason: string,
    reply: string,
  ): Promise<void> {
    const lead = await this.prisma.lead.findFirst({
      where: { companyId, phone },
      select: { name: true },
    })
    const display = lead?.name ? `${lead.name} (${phone})` : phone
    const notifMsg = `عميل جاهز للدفع — يحتاج تواصل من فريق المبيعات: ${display}`
    await Promise.all([
      this.prisma.conversation.update({
        where: { id: convId },
        data: { needsSalesContact: true, salesAlertReason: reason, bookingStage: 'DONE' },
      }),
      this.prisma.systemNotification.create({
        data: { companyId, type: 'SALES_CONTACT_NEEDED', message: notifMsg },
      }),
    ])
    await this.saveAssistantMessage(convId, reply)
    console.log(`BOOKING_ALERT → ${phone} | reason=${reason}`)
  }

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
          await this.saveAssistantMessage(conv.id, welcomeBack)
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
            await this.saveAssistantMessage(conv.id, bMsg)
            console.log(`BOOKING_GOV_RESOLVED → ${phone} gov=${gov}`)
            return bMsg
          }
          const askAgain = 'معلش يافندم، مفهمتش — حضرتك من أنهي محافظة بالضبط؟'
          await this.saveAssistantMessage(conv.id, askAgain)
          return askAgain
        }

        if (conv.bookingStage === 'AWAITING_BRANCH_CONFIRM') {
          if (detectOnlinePayment(text)) {
            const r = 'تمام يافندم، هنترتبلك مع زميلنا المختص بخصوص طريقة الدفع الأونلاين وسيتواصل معك قريباً إن شاء الله'
            await this.completeBookingAlert(conv.id, companyId, phone, 'wants_online_payment', r)
            return r
          }
          if (detectFarFromBranch(text)) {
            const r = 'تمام يافندم، هنترتبلك أنسب حاجة مع زميلنا المختص وسيتواصل معك قريباً إن شاء الله'
            await this.completeBookingAlert(conv.id, companyId, phone, 'far_from_branch', r)
            return r
          }
          if (detectVisitConfirm(text)) {
            const r = 'ممتاز يافندم! فريقنا هيكون في انتظارك بالفرع إن شاء الله، وأي استفسار أنا هنا'
            await this.completeBookingAlert(conv.id, companyId, phone, 'wants_branch_visit', r)
            return r
          }
          const clarify = 'معلش يافندم، هتيجي للفرع؟ أم تفضل يتواصل معك أحد زملائنا؟'
          await this.saveAssistantMessage(conv.id, clarify)
          return clarify
        }

        // After booking confirmed — short ack for any follow-up messages
        if (conv.needsSalesContact) {
          const ack = 'تمام يافندم، فريق المبيعات هيتواصل معك قريباً إن شاء الله'
          await this.saveAssistantMessage(conv.id, ack)
          return ack
        }

        // Repeat booking keyword after handoff already sent → short ack, no AI call
        if (conv.handoffMessageSent && BOOKING_KEYWORDS.some(kw => text.includes(kw))) {
          const repeatAck = 'تمام يافندم زميلنا هيتواصل معك في أقرب وقت إن شاء الله'
          await this.saveAssistantMessage(conv.id, repeatAck)
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
          this.writeCostRecord(companyId, conv.id, r.costUSD)
        } catch (err) {
          if (err instanceof ApiCreditsExhaustedError) await this.handleAICreditsExhausted(companyId)
        }
        const replyNH = applyHajjDateDisclaimer(rawNHReply)
        await this.saveAssistantMessage(conv.id, replyNH)
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
      await this.saveAssistantMessage(conv.id, clarify)
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

        await this.saveAssistantMessage(conv.id, fdReply)
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
          await this.saveAssistantMessage(conv.id, detail)
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
        await this.saveAssistantMessage(conv.id, intro)
        const parts: string[] = [intro]

        if (isHajjOv) {
          const ovMsg = prebuiltCatalog.hajjOverviewMessage + '\n\n' + HAJJ_OV_DISCLAIMER
          this.overviewMap.set(conv.id, { orderedDetails: prebuiltCatalog.hajjOverviewDetails })
          await this.saveAssistantMessage(conv.id, ovMsg)
          parts.push(ovMsg)
          console.log(`HAJJ_OV_BYPASS → ${phone} programs=${prebuiltCatalog.hajjOverviewDetails.length}`)
        } else if (isUmrahOv && ovMonth) {
          const ovMsg = prebuiltCatalog.umrahMonthMessages[ovMonth]
          await this.saveAssistantMessage(conv.id, ovMsg)
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
        await this.saveAssistantMessage(conv.id, intro)
        const parts: string[] = [intro]

        if (isHajjOvFirst) {
          const ovMsg = prebuiltCatalog.hajjOverviewMessage + '\n\n' + HAJJ_OV_DISCLAIMER
          this.overviewMap.set(conv.id, { orderedDetails: prebuiltCatalog.hajjOverviewDetails })
          await this.saveAssistantMessage(conv.id, ovMsg)
          parts.push(ovMsg)
          console.log(`HAJJ_OV_ZERO_AI → ${phone} programs=${prebuiltCatalog.hajjOverviewDetails.length}`)
        } else if (firstMsgUmrahMonth) {
          const ovMsg = prebuiltCatalog.umrahMonthMessages[firstMsgUmrahMonth]
          await this.saveAssistantMessage(conv.id, ovMsg)
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
      if (err instanceof ApiCreditsExhaustedError) await this.handleAICreditsExhausted(companyId)
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
      await this.saveAssistantMessage(conv.id, rawAIReply)
      console.log(`AI_FAILURE_1 → ${phone} (failure count: ${fc})`)
      return rawAIReply
    }

    this.aiFailureCount.delete(conv.id)
    this.writeCostRecord(companyId, conv.id, aiCostUSD)
    const reply = applyHajjDateDisclaimer(rawAIReply)

    await this.saveAssistantMessage(conv.id, reply)

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
        if (err instanceof ApiCreditsExhaustedError) await this.handleAICreditsExhausted(companyId)
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
          await this.saveAssistantMessage(conv.id, ovMsg)
          console.log(`HAJJ_OV_FIRST → ${phone} programs=${prebuiltCatalog.hajjOverviewDetails.length}`)
          return [reply, ovMsg]
        }

        // ── Umrah month bypass: send pre-built month message, no second AI call ──
        if (umrahMonth && prebuiltCatalog?.umrahMonthMessages?.[umrahMonth]) {
          const ovMsg = prebuiltCatalog.umrahMonthMessages[umrahMonth]
          await this.saveAssistantMessage(conv.id, ovMsg)
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
          if (err instanceof ApiCreditsExhaustedError) await this.handleAICreditsExhausted(companyId)
        }
        if (secondReply && secondReply !== AI_ERROR_REPLY) {
          const secondCleaned = applyHajjDateDisclaimer(secondReply)
          await this.saveAssistantMessage(conv.id, secondCleaned)
          this.writeCostRecord(companyId, conv.id, secondCost)
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
      await this.saveAssistantMessage(conv.id, ack)
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
    await this.saveAssistantMessage(conv.id, bookingMsg)
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
      this.writeCostRecord(conv.companyId, convId, r.costUSD)
    } catch (err) {
      if (err instanceof ApiCreditsExhaustedError) await this.handleAICreditsExhausted(conv.companyId)
    }
    const reply = applyHajjDateDisclaimer(rawTriggerReply)

    await this.saveAssistantMessage(convId, reply)
    console.log(`MANUAL_AI_REPLY → conv=${convId} phone=${conv.phone}`)

    return { reply, phone: conv.phone, waToken: company.waToken, waPhoneId: company.waPhoneId }
  }
}
