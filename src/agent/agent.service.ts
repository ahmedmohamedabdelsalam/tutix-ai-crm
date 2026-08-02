import Anthropic from '@anthropic-ai/sdk';
import { Industry } from '@prisma/client';
import { buildBasePersonality } from './prompts/base-personality';
import { getIndustryPrompt } from './prompts/index';
import { HotelEntry, findHotelInMessage, findHotelInMessageFromData } from './prompts/hajj-umrah-hotels';

export interface PrebuiltCatalog {
  identity: string
  catalog: string
  hotels: string
  hotelList: HotelEntry[]
  monthOverviews: string
  hajjProgramDetails: string[]
  hajjOverviewMessage: string
  hajjOverviewDetails: string[]
  hajjCategoryQuestion: string
  hajjEconomyPrograms: string
  hajjEconomyDetails: string[]
  hajjFiveStarPrograms: string
  hajjFiveStarDetails: string[]
  hajjKadanPrograms: string
  hajjKadanDetails: string[]
  rawUmrahPrograms: any[]
  umrahMonthMessages: Record<string, string>
  umrahMonthDetails: Record<string, string[]>
  umrahMonthLevelMessages: Record<string, Record<string, string>>
  umrahAllMonthsMessage: string
  umrahAllMonthsDetails: string[]
  // Batch-1 handlers
  ctaReply: string
  umrahDurationMessages: Record<number, string>
  umrahDurationDetails: Record<number, string[]>
  availableDurations: number[]
  durationPivotMsg: string
  hasFutureOfferings: boolean
}

// Lazy init — created on first use, after NestJS has loaded env vars
let _anthropic: Anthropic | null = null;

function getClient(): Anthropic {
  if (!_anthropic) {
    _anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });
  }
  return _anthropic;
}

export class ApiCreditsExhaustedError extends Error {
  constructor(public readonly reason: string) {
    super(`Anthropic API credits exhausted: ${reason}`);
    this.name = 'ApiCreditsExhaustedError';
  }
}

export const AI_ERROR_REPLY = 'عذراً حدث خطأ سيتواصل معك أحد المتخصصين قريباً';

function buildSystemPrompt(
  companyName: string,
  packages: string,
  aiPrompt: string,
  waPhone: string,
  industry: Industry = Industry.HAJJ_UMRAH,
  returningCustomer?: { name: string; tripsCount: number },
  knownCustomerName?: string,
  dynamicFAQs?: { question: string; answer: string }[],
  prebuiltCatalog?: PrebuiltCatalog,
): string {
  const bookingCta = `قل: "تمام يافندم هحول حضرتك لزميلي المختص يكمل معاك خطوات الحجز إن شاء الله"`;

  const { identity, catalog, hotels } = prebuiltCatalog ?? getIndustryPrompt(industry, companyName);
  let prompt = buildBasePersonality(identity, catalog, bookingCta, hotels, returningCustomer, knownCustomerName, companyName);

  // Append DB-driven updates (override base prices if contradicted)
  if (packages && packages.trim()) {
    prompt += `\n\n═══════════════════════════════
التحديثات الأخيرة على الأسعار والبرامج
═══════════════════════════════
(هذه التحديثات تُلغي الأسعار الأساسية عند التعارض)
${packages.trim()}`;
  }

  // Append operational notes / special instructions
  if (aiPrompt && aiPrompt.trim()) {
    prompt += `\n\n═══════════════════════════════
تعليمات وملاحظات إضافية
═══════════════════════════════
${aiPrompt.trim()}`;
  }

  // Inject company-specific answered FAQs from DB (added by TUTIX admin)
  if (dynamicFAQs && dynamicFAQs.length > 0) {
    const faqLines = dynamicFAQs.map((f, i) => `س${i + 1}: ${f.question}\nج${i + 1}: ${f.answer}`).join('\n\n')
    prompt += `\n\n═══════════════════════════════
إجابات جاهزة معتمدة من الإدارة
═══════════════════════════════
استخدم هذه الإجابات حرفياً عند سؤال مشابه:

${faqLines}`;
  }

  // Anti-hallucination rule always last — closest to generation
  prompt += `\n\nتوقف بعد ردّك مباشرة — لا تكتب ما يمكن أن يقوله العميل بعدها`;

  return prompt;
}

function cleanAgentResponse(text: string): string {
  // Strip any lines that are purely "للعمرة" (model preamble) and remove leading blank lines
  let t = text
    .split('\n')
    .filter(line => !/^للعمرة[^؀-ۿ]*$/.test(line.trim()))
    .join('\n')
    .replace(/^\n+/, '');

  // Strip single-word leading fragment — model sometimes completes user's last word first
  // e.g. user says "10" → model outputs "ايام\nتمام يا أستاذ..." ; "المدينه" → "اولا\nتمام..."
  const firstNlIdx = t.indexOf('\n');
  if (firstNlIdx > 0) {
    const firstToken = t.substring(0, firstNlIdx).trim();
    // Single word (no spaces), ≤10 chars, no question mark or ━ = likely a preamble fragment
    if (!firstToken.includes(' ') && firstToken.length <= 10 && !firstToken.includes('؟') && !firstToken.includes('━')) {
      const rest = t.substring(firstNlIdx).replace(/^\n+/, '');
      if (rest.length > 15) t = rest;
    }
  }

  // Strip conversation-delimiter artifacts like <<HUMAN_CONVERSATION_END>> — truncate at first "<<"
  const delimIdx = t.indexOf('<<');
  if (delimIdx !== -1) t = t.substring(0, delimIdx).trimEnd();

  // Truncate hallucinated customer turns — model sometimes generates fake customer replies.
  // Two strategies:
  // 1. Known markers for first-person customer phrases
  const fakeCustomerMarkers = [
    '\n\nتمام — أنا ', '\n\nأنا عايز', '\n\nأنا هاخد', '\n\nأيوه،',
    '\n\nتمام كويس', '\n\nتمام حلو', '\n\nاحنا نفكر', '\n\nهنفكر',
    '\n\nهنكلمك', '\n\nنرد عليك', '\n\nسنفكر', '\n\nعايز احجز',
    '\n\nعايزة احجز', '\n\nموافق نحجز', '\n\nهحجز', '\n\nعايز ',
    '\n\nعايزة ',
  ];
  for (const marker of fakeCustomerMarkers) {
    const idx = t.indexOf(marker);
    if (idx !== -1) t = t.substring(0, idx).trimEnd();
  }
  // 2. Structural detection: if a short middle paragraph contains a customer-style hallucination.
  // "احنا" removed — agent also uses it to mean "we (the company)"
  const customerWords = ['أنا عايز', 'أنا هاخد', 'هنفكر', 'نرد عليك', 'هنكلمك', 'سنفكر', 'نفكر فيها'];
  const blocks = t.split('\n\n');
  if (blocks.length >= 3) {
    for (let i = 1; i < blocks.length - 1; i++) {
      const block = blocks[i].trim();
      const isKnownPhrase = customerWords.some(kw => block.includes(kw));
      // Very short isolated block (1–8 chars) with no ⭐ = one-word fake customer reply (e.g. "يوليو", "10 ايام")
      // Must be non-empty — empty separator blocks between program cards must NOT trigger truncation
      const isOneWordReply = block.length >= 1 && block.length <= 8 && !block.includes('⭐') && !block.includes('—');
      if (block.length <= 80 && !block.includes('⭐') && (isKnownPhrase || isOneWordReply)) {
        t = blocks.slice(0, i).join('\n\n').trimEnd();
        break;
      }
    }
  }

  const cleaned = t
    .replace(/\*\*/g, '')          // remove markdown bold **
    .replace(/[،!]/g, '')          // remove ، !
    .replace(/(?<!\S)\.|\.(?!\S)/g, '') // remove standalone dots (not inside URLs/words)
    .replace(/—/g, ' ')            // remove em-dashes (replaced with space)
    .replace(/[ \t]+/g, ' ')  // normalize spaces (preserve newlines for package cards)
    .trim();
  return cleaned || text.trim(); // fallback to original if cleaning empties the string
}

export interface LeadFacts {
  packageType?: string | null
  groupSize?: number | null
  travelDate?: string | null
  budget?: string | null
  companionNote?: string | null
}

function buildKnownFactsBlock(facts?: LeadFacts): string {
  if (!facts) return ''
  const lines: string[] = []
  if (facts.packageType) lines.push(`نوع الرحلة: ${facts.packageType}`)
  if (facts.groupSize) lines.push(`عدد الأفراد: ${facts.groupSize}`)
  if (facts.travelDate) lines.push(`موعد السفر المفضل: ${facts.travelDate}`)
  if (facts.budget) lines.push(`الميزانية: ${facts.budget}`)
  if (facts.companionNote) lines.push(`صلة المرافق: ${facts.companionNote}`)
  if (lines.length === 0) return ''
  return `## معلومات مؤكدة عن هذا العميل في هذه المحادثة
المعلومات التالية أكدها العميل في هذه المحادثة وسُجّلت تلقائياً:
${lines.map(l => `• ${l} ✅`).join('\n')}
⛔ ممنوع تماماً إعادة سؤال العميل عن أي معلومة مذكورة أعلاه — استخدمها مباشرةً في ردّك بدون تكرار السؤال
⛔ صلة المرافق ثابتة: استخدم "صلة المرافق" الموثقة أعلاه ولا تخترع علاقات أخرى أو تحوّل "والدته" إلى "صاحبه" أو أي تحويل آخر`
}

export async function getAgentReply(
  history: { role: string; content: string }[],
  companyName: string,
  packages: string,
  aiPrompt = '',
  waPhone = '',
  industry: Industry = Industry.HAJJ_UMRAH,
  returningCustomer?: { name: string; tripsCount: number },
  knownCustomerName?: string,
  dynamicFAQs?: { question: string; answer: string }[],
  knownLeadFacts?: LeadFacts,
  prebuiltCatalog?: PrebuiltCatalog,
): Promise<{ reply: string; costUSD: number }> {
  try {
    let messages = history.map((m) => ({
      role: m.role.toLowerCase() === 'user' ? 'user' as const : 'assistant' as const,
      content: m.content,
    }));

    // When we know the customer's name and this is their first message in a new conversation,
    // use Anthropic's assistant-turn pre-fill technique: append an incomplete assistant message
    // so the model continues from a greeting-by-name and cannot ask for the name again.
    let prefill = '';
    if (knownCustomerName && history.length === 1) {
      const firstMsg = history[0].content.trim();
      const isGreeting = /^(السلام|أهلاً|اهلاً|اهلا|مرحبا|هاي|هاى|صباح|مسا|ازيك)/.test(firstMsg);
      prefill = isGreeting
        ? `وعليكم السلام ورحمة الله يا أستاذ ${knownCustomerName} نورتنا تاني يافندم`
        : `أهلاً يا أستاذ ${knownCustomerName} نورتنا تاني يافندم`;
      messages = [...messages, { role: 'assistant' as const, content: prefill }];
    }

    // Detect hotel name in last user message → injected as a separate uncached block
    const lastUserMsg = history.filter(m => m.role.toLowerCase() === 'user').slice(-1)[0]?.content ?? '';
    const hotelOverride = prebuiltCatalog?.hotelList
      ? findHotelInMessageFromData(lastUserMsg, prebuiltCatalog.hotelList)
      : findHotelInMessage(lastUserMsg);

    // Base system prompt is identical across all calls for the same company → cache it.
    // Known facts (conversation-specific) and hotel info are separate uncached blocks so
    // the cached portion stays stable and gets a cache hit on every subsequent message.
    const sysPrompt = buildSystemPrompt(companyName, packages, aiPrompt, waPhone, industry, returningCustomer, knownCustomerName, dynamicFAQs, prebuiltCatalog);
    const factsBlock = buildKnownFactsBlock(knownLeadFacts);
    const systemBlocks = [
      { type: 'text' as const, text: sysPrompt, cache_control: { type: 'ephemeral' as const } },
      ...(factsBlock ? [{ type: 'text' as const, text: factsBlock }] : []),
      ...(hotelOverride ? [{ type: 'text' as const, text: hotelOverride }] : []),
    ];

    const response = await getClient().messages.create({
      model: process.env.AI_MODEL ?? 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      temperature: 0.3,
      system: systemBlocks,
      messages,
    });

    const u = response.usage;
    const cacheRead = u.cache_read_input_tokens ?? 0;
    const cacheWrite = u.cache_creation_input_tokens ?? 0;
    const costUSD = (
      (u.input_tokens * 0.80 / 1_000_000) +
      (u.output_tokens * 4.00 / 1_000_000) +
      (cacheRead * 0.08 / 1_000_000) +
      (cacheWrite * 1.00 / 1_000_000)
    ).toFixed(6);
    console.log('TOKEN_USAGE:', JSON.stringify({
      type: 'reply', msgCount: history.length,
      inputTokens: u.input_tokens, outputTokens: u.output_tokens,
      cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite,
      estimatedCostUSD: costUSD,
    }));

    const rawReply = prefill +
      (response.content[0]?.type === 'text'
        ? response.content[0].text
        : AI_ERROR_REPLY);
    console.log(`RAW_REPLY: ${rawReply.substring(0, 300).replace(/\n/g, '↵')}`);
    return { reply: cleanAgentResponse(rawReply), costUSD: Number(costUSD) };
  } catch (err: any) {
    if (err.status === 400 && err.error?.type === 'credit_balance_too_low') {
      console.error('🔴 ANTHROPIC_CREDITS_EXHAUSTED: credit_balance_too_low');
      throw new ApiCreditsExhaustedError('credit_balance_too_low');
    }
    if (err.status === 429) {
      console.error('🔴 ANTHROPIC_CREDITS_EXHAUSTED: rate_limit_429');
      throw new ApiCreditsExhaustedError('rate_limit_429');
    }
    console.error('AI error:', err);
    return { reply: AI_ERROR_REPLY, costUSD: 0 };
  }
}

export async function extractLeadData(
  history: { role: string; content: string }[],
): Promise<{ data: Partial<LeadData>; costUSD: number }> {
  const prompt = `من المحادثة التالية استخرج بيانات العميل. أجب بـ JSON فقط:
{"name":"الاسم أو null","packageType":"حج أو عمرة أو null","groupSize":عدد صحيح أو null,"budget":"الميزانية أو null","travelDate":"الموعد أو null","isReadyToBook":true أو false,"companionNote":"وصف مختصر لصلة المرافق مثل: مسافر مع والدته، مسافر مع زوجته، مسافر مع ابنه — أو null لو ما ذُكرت صلة المرافق"}

قواعد مهمة:
1. isReadyToBook يكون true فقط إذا قال العميل صراحةً إنه يريد الحجز الآن بعبارات مثل "عايز احجز" أو "هحجز" أو "موافق نحجز". مجرد السؤال عن العمرة أو الأسعار لا يعني الاستعداد للحجز.
2. groupSize: استخرج عدد الأفراد من الصيغ الصريحة والضمنية:
   - "أنا ووالدي" أو "أنا وأبويا" أو "أنا وأمي" أو "أنا وزوجتي" أو "أنا ومراتي" → 2
   - "أنا وزوجتي وابني" أو "أنا ومراتي وولدي" أو أي صيغة تذكر ٣ أشخاص → 3
   - "أنا لوحدي" أو "بمفردي" أو "فرد واحد" → 1
   - "أنا وأهلي" أو "أنا وعيلتي" بدون عدد محدد → null
   - الأرقام الصريحة: "اتنين" أو "٢" أو "2" → 2 ؛ "تلاتة" أو "٣" أو "3" → 3
3. "بس" أو "فقط" بعد اسم شخص = العميل نفسه غير مشمول في العدد:
   - "والدي بس" / "والدي فقط" / "بس والدي" → 1 (الوالد فقط، العميل لا يسافر)
   - "أمي بس" / "أمي فقط" → 1
   - "زوجتي بس" / "مراتي بس" / "مراتي فقط" → 1
   - "أنا بس" / "أنا فقط" / "أنا لوحدي" → 1 (العميل وحده)
   - القاعدة العامة: "[شخص] بس" أو "بس [شخص]" = شخص واحد فقط — لا تفترض أن العميل ضمن العدد إلا لو صرّح بـ"أنا و..."
4. كلمة "معايا" بعد ذكر أفراد = العميل نفسه مشمول في العدد:
   - "زوجتي وطفلين معايا" أو "عيلتي زوجتي وطفلين معايا" → العميل + زوجة + ٢ أطفال = 4
   - "أبويا معايا" → العميل + والده = 2
   لكن إذا الصياغة فيها غموض حول ما إذا كان العميل ضمن العدد (مثل "عيلتي زوجتي وطفلين") بدون "معايا" صريحة → استخرج null
5. packageType: استخرجه فقط إذا ذكر العميل صراحةً كلمة "حج" أو "عمرة" أو "عمره" (العامية لعمرة). حديث العميل عن مواعيد أو أسعار أو عدد الأفراد بدون ذكر نوع الرحلة لا يعني عمرة تلقائياً → packageType يبقى null

المحادثة:
${history.map((m) => `${m.role === 'user' ? 'العميل' : 'المساعد'}: ${m.content}`).join('\n')}`;

  try {
    const response = await getClient().messages.create({
      model: process.env.AI_MODEL ?? 'claude-haiku-4-5-20251001',
      max_tokens: 150,
      messages: [{ role: 'user', content: prompt }],
    });
    const eu = response.usage;
    const eCostUSD = (
      (eu.input_tokens * 0.80 / 1_000_000) +
      (eu.output_tokens * 4.00 / 1_000_000)
    ).toFixed(6);
    console.log('TOKEN_USAGE:', JSON.stringify({
      type: 'extract', msgCount: history.length,
      inputTokens: eu.input_tokens, outputTokens: eu.output_tokens,
      cacheReadTokens: 0, cacheWriteTokens: 0,
      estimatedCostUSD: eCostUSD,
    }));
    const text =
      response.content[0]?.type === 'text' ? response.content[0].text : '{}';
    const json = text.match(/\{[\s\S]*\}/)?.[0] ?? '{}';
    return { data: JSON.parse(json) as Partial<LeadData>, costUSD: Number(eCostUSD) };
  } catch (err: any) {
    if (err.status === 400 && err.error?.type === 'credit_balance_too_low') {
      console.error('🔴 ANTHROPIC_CREDITS_EXHAUSTED: credit_balance_too_low (extract)');
      throw new ApiCreditsExhaustedError('credit_balance_too_low');
    }
    if (err.status === 429) {
      console.error('🔴 ANTHROPIC_CREDITS_EXHAUSTED: rate_limit_429 (extract)');
      throw new ApiCreditsExhaustedError('rate_limit_429');
    }
    return { data: {}, costUSD: 0 };
  }
}

export function calculateScore(data: Partial<LeadData>): number {
  let score = 0;
  if (data.name) score += 20;
  if (data.groupSize) score += 15;
  if (data.budget) score += 25;
  if (data.travelDate) score += 25;
  if (data.packageType) score += 15;
  return score;
}

export const BOOKING_KEYWORDS = [
  'عايز احجز', 'عايزة احجز', 'هحجز', 'موافق نحجز', 'تمام هنحجز',
  'خد الحجز', 'احجزلي', 'احجزي لي', 'نحجز دلوقتي', 'كمل الحجز',
  'ابدأ الحجز', 'خليني احجز', 'اوك نحجز', 'اوكيه نحجز',
  // hamza variants (أ vs ا — both common in Egyptian typing)
  'عايز أحجز', 'عايزة أحجز', 'خليني أحجز', 'أحجزلي',
  // payment intent
  'عايز أدفع', 'عايز ادفع', 'عايزة ادفع', 'عايزة أدفع', 'هدفع',
  'فودافون كاش', 'إنستاباي', 'انستاباي', 'اتمم الدفع', 'ادفع النه',
];

function hasExplicitBookingIntent(lastUserMessage: string): boolean {
  const normalized = lastUserMessage.trim().toLowerCase();
  return BOOKING_KEYWORDS.some(kw => normalized.includes(kw));
}

const FRUSTRATION_KEYWORDS = [
  'مش فاهم', 'انت فاهمني غلط', 'فاهمني غلط',
  'كلمني حد', 'عايز حد', 'اتكلم مع حد', 'مش بيفهم',
]

function hasFrustrationSignal(text: string): boolean {
  return FRUSTRATION_KEYWORDS.some(kw => text.includes(kw))
}

export function shouldHandoff(
  score: number,
  msgCount: number,
  data: Partial<LeadData>,
  lastUserMessage = '',
): { yes: boolean; reason: string } {
  if (hasExplicitBookingIntent(lastUserMessage)) return { yes: true, reason: 'العميل جاهز للحجز' }
  if (score >= 60) return { yes: true, reason: 'ليد ساخن' }
  if (hasFrustrationSignal(lastUserMessage)) return { yes: true, reason: 'العميل محتاج تدخل بشري' }
  if (msgCount >= 30) return { yes: true, reason: 'محادثة طويلة' }
  return { yes: false, reason: '' }
}

export interface LeadData {
  name: string;
  phone: string;
  packageType: string;
  groupSize: number;
  budget: string;
  travelDate: string;
  isReadyToBook: boolean;
  companionNote: string;
}
