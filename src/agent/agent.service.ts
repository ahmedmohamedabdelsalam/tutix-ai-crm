import OpenAI from 'openai';

// Lazy init — created on first use, after NestJS has loaded env vars
let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!_client) {
    _client = new OpenAI({
      baseURL: process.env.AI_BASE_URL,
      apiKey: process.env.AI_API_KEY,
    });
  }
  return _client;
}

function getModel(): string {
  return process.env.AI_MODEL ?? 'llama3-70b-8192';
}

function buildSystemPrompt(
  companyName: string,
  packages: string,
  aiPrompt: string,
  waPhone: string,
): string {
  // Step 8 booking CTA — show real contact if available, otherwise generic
  const bookingCta = waPhone
    ? `قوله: "ممتاز! للإتمام والحجز، تواصل معنا مباشرة على: ${waPhone}\nأو قم بزيارة أقرب فرع: دمياط | القاهرة | الإسكندرية"`
    : `قوله: "ممتاز! سيتواصل معك أحد متخصصينا لإتمام الحجز وتأكيد المقعد."`;

  let prompt = `أنت مستشار حجوزات في إسكندرية الدولية للسياحة (الساحة ترافيل سابقاً) — دافئ، مصري، ملتزم دينياً. فروع: دمياط|القاهرة|الإسكندرية. مرشدون: الشيخ أحمد المنجي | د. إبراهيم الغانوس. تقييم: 98%

── برامج العمرة 2026 (الأسعار للفرد بالجنيه) ──
7أيام يوليو | الصفوة3★+شذا ريجنسي | طيران+قطار | إفطار | 20-26/7 ← ثنائي:62,800 | ثلاثي:57,000 | رباعي:53,500
7أيام يوليو | رمادا3★+زوار العالمي | طيران+قطار | 20-26/7 ← ثنائي:52,000 | ثلاثي:47,500 | رباعي:45,500
7أيام أغسطس | الصفوة3★+شذا ريجنسي | طيران+قطار | إفطار | 10-16/8 ← ثنائي:63,600 | ثلاثي:57,900 | رباعي:54,000
7أيام أغسطس | رمادا3★+زوار العالمي | طيران+قطار | 10-16/8 ← ثنائي:53,100 | ثلاثي:48,100 | رباعي:46,100
10أيام يوليو مكة-أولاً | الصفوة5★+الحارثية4★ | طيران+قطار | إفطار | 14-23/7 ← ثنائي:83,900 | ثلاثي:73,400 | رباعي:68,000
10أيام يوليو مكة-أولاً | أذكي الصفا5★+جراند بلازا | طيران+قطار | إفطار | 14-23/7 ← ثنائي:62,700 | ثلاثي:55,700 | رباعي:52,700
10أيام يوليو مدينة-أولاً | الصفوة5★+الحارثية4★ | طيران+قطار | إفطار | 26/7-4/8 ← ثنائي:85,900 | ثلاثي:74,900 | رباعي:69,900
10أيام يوليو مدينة-أولاً | أذكي الصفا5★+جراند بلازا | طيران+قطار | 26/7-4/8 ← ثنائي:63,200 | ثلاثي:56,200 | رباعي:53,000
11يوم يوليو مكة-أولاً | رمادا6★+زوار العالمي4★ | طيران | قطار اختياري | 21/7-31/8 ← ثنائي:59,000 | ثلاثي:52,500 | رباعي:47,500
11يوم أغسطس مكة-أولاً | إعمار المنار6★+زوار العالمي4★ | طيران | قطار اختياري | 5-15/8 ← ثنائي:59,700 | ثلاثي:52,700 | رباعي:48,700
15يوم يوليو مدينة-أولاً | فنادق10★+4★ | طيران خاص | قطار اختياري | 8-22/7 ← ثنائي:50,100 | ثلاثي:44,500 | رباعي:39,900
15يوم يوليو مدينة-أولاً | إعمار المنار10★+زوار العالمي | طيران سعودي | إفطار | قطار اختياري | 8-22/7 ← ثنائي:65,500 | ثلاثي:57,900 | رباعي:53,500

── خطوات البيع ──
١- أول رسالة دائماً: "أهلاً وسهلاً بحضرتك نورتنا يافندم\nتشرفنا باسم حضرتك؟" — لا تسأل عن غير الاسم.
٢- بعد الاسم: "أهلاً يا أستاذ [الاسم] نورتنا\nبيخدمك إيه يافندم؟\nعندنا برامج عمرة وحج ليوليو وأغسطس — تحب أعرفك بالبرامج؟" — انتظر رده.
٣- عميل عائد: "أهلاً بعودتك يا أستاذ [الاسم] نورتنا تاني\nإزيك يافندم؟ في حاجة أقدر أساعدك فيها؟"
٤- بعد الاهتمام: "كم شخص هيسافر معاك يافندم؟ بالغين وأطفال لو فيه؟"
٥- "حضرتك بتفكر في يوليو ولا أغسطس يافندم؟"
٦- "وبتفضل المدة أيه يافندم — ٧ أيام ولا ١٠ أيام ولا أكتر؟"
٧- عرض برنامجين بالشكل ده (ابدأ بالأغلى):
"يافندم عندنا برنامجين مناسبين إن شاء الله:"
━━━━━━━━━━━━━━━
[اسم الفندق] ⭐⭐⭐
السعر للفرد: [السعر بأرقام عربية] جنيه
الإجمالي لـ[عدد] أشخاص: [الإجمالي] جنيه
يشمل: طيران + قطار الحرمين + إفطار يومي
━━━━━━━━━━━━━━━
بعدها: "الأماكن بدأت تتضيق يافندم — أيهما يناسب حضرتك إن شاء الله؟"
٨- عند الحجز: ${bookingCta}

── الاعتراضات ──
غالي: "الفندق ده خطوات من الكعبة وبيشمل إفطار وطيران سعودي — وعندنا تقسيط مريح يافندم"
هفكر: "توكل على الله يافندم — الأماكن بتخلص بسرعة الموسم ده"
منافسين أرخص: "٩٨٪ من عملاءنا بيوصوا بينا — ومعانا مرشدون روحانيون بيفرقوا كتير"
إن شاء الله: "اللهم آمين يافندم ربنا ييسر ويبارك"

── قواعد صارمة ──
لا تذكر أسعار من خارج البرامج أعلاه
لا تستخدم markdown أو نقاط أو أرقام في القوائم
كل رسالة ٥ أسطر بحد أقصى ما عدا بطاقة البرنامج
لا نقطة(.) ولا تعجب(!) في نهاية الجمل — استخدم(؟) للأسئلة فقط
لا إيموجي إلا ⭐ في بطاقة البرنامج
سؤال واحد فقط في كل رسالة
التأشيرة مشمولة | الإفطار مشمول في أغلب البرامج | تقسيط متاح
لو سألك عن معلومة مش عندك: "سيتواصل معك أحد متخصصينا"
لا تقل أنك AI إلا لو سألك مباشرة
استخدم الأرقام العربية: ١٢٣٤٥٦٧٨٩٠`;

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

  return prompt;
}

function cleanAgentResponse(text: string): string {
  const cleaned = text
    .replace(/[.،!]/g, '')    // remove . ، !
    .replace(/[ \t]+/g, ' ')  // normalize spaces (preserve newlines for package cards)
    .trim();
  return cleaned || text.trim(); // fallback to original if cleaning empties the string
}

export async function getAgentReply(
  history: { role: string; content: string }[],
  companyName: string,
  packages: string,
  aiPrompt = '',
  waPhone = '',
): Promise<string> {
  try {
    const res = await getClient().chat.completions.create({
      model: getModel(),
      messages: [
        { role: 'system', content: buildSystemPrompt(companyName, packages, aiPrompt, waPhone) },
        ...history.map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        })),
      ],
      temperature: 0.7,
      max_tokens: 500,
    });
    const rawReply = res.choices[0].message.content ?? 'عذراً حدث خطأ سيتواصل معك أحد المتخصصين';
    return cleanAgentResponse(rawReply);
  } catch (err) {
    console.error('AI error:', err);
    return 'عذراً حدث خطأ سيتواصل معك أحد المتخصصين قريباً';
  }
}

export async function extractLeadData(
  history: { role: string; content: string }[],
): Promise<Partial<LeadData>> {
  const prompt = `من المحادثة التالية استخرج بيانات العميل. أجب بـ JSON فقط:
{"name":"الاسم أو null","packageType":"حج أو عمرة أو null","groupSize":عدد أو null,"budget":"الميزانية أو null","travelDate":"الموعد أو null","isReadyToBook":true أو false}

قاعدة مهمة: isReadyToBook يكون true فقط إذا قال العميل صراحةً إنه يريد الحجز الآن بعبارات مثل "عايز احجز" أو "هحجز" أو "موافق نحجز". مجرد السؤال عن العمرة أو الأسعار لا يعني الاستعداد للحجز.

المحادثة:
${history.map((m) => `${m.role === 'user' ? 'العميل' : 'المساعد'}: ${m.content}`).join('\n')}`;

  try {
    const res = await getClient().chat.completions.create({
      model: 'llama-3.1-8b-instant', // fast small model — extraction only, saves main quota
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      max_tokens: 150,
    });
    const text = res.choices[0].message.content ?? '{}';
    const json = text.match(/\{[\s\S]*\}/)?.[0] ?? '{}';
    return JSON.parse(json) as Partial<LeadData>;
  } catch {
    return {};
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

const BOOKING_KEYWORDS = [
  'عايز احجز', 'عايزة احجز', 'هحجز', 'موافق نحجز', 'تمام هنحجز',
  'خد الحجز', 'احجزلي', 'احجزي لي', 'نحجز دلوقتي', 'كمل الحجز',
  'ابدأ الحجز', 'خليني احجز', 'اوك نحجز', 'اوكيه نحجز',
];

function hasExplicitBookingIntent(lastUserMessage: string): boolean {
  const normalized = lastUserMessage.trim().toLowerCase();
  return BOOKING_KEYWORDS.some(kw => normalized.includes(kw));
}

export function shouldHandoff(
  score: number,
  msgCount: number,
  data: Partial<LeadData>,
  lastUserMessage = '',
): { yes: boolean; reason: string } {
  // Handoff only on explicit booking keyword in the actual message (never on score alone)
  if (hasExplicitBookingIntent(lastUserMessage)) {
    return { yes: true, reason: 'العميل جاهز للحجز' };
  }
  // Safety fallback for very long conversations
  if (msgCount >= 16) return { yes: true, reason: 'محادثة طويلة' };
  return { yes: false, reason: '' };
}

export interface LeadData {
  name: string;
  phone: string;
  packageType: string;
  groupSize: number;
  budget: string;
  travelDate: string;
  isReadyToBook: boolean;
}
