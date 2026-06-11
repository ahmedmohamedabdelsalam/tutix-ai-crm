import Anthropic from '@anthropic-ai/sdk';

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

function buildSystemPrompt(
  companyName: string,
  packages: string,
  aiPrompt: string,
  waPhone: string,
): string {
  const bookingCta = waPhone
    ? `قل: "تمام يافندم هحول حضرتك لزميلي المختص يكمل معاك خطوات الحجز إن شاء الله وللتواصل المباشر: ${waPhone}"`
    : `قل: "تمام يافندم هحول حضرتك لزميلي المختص يكمل معاك خطوات الحجز إن شاء الله"`;

  let prompt = `## قاعدة الرسالة الواحدة — أهم تعليمة
ردّك يكون رسالة واحدة فقط — بعد ما تنهي ردّك لا تكمل — لا تكتب ما يمكن أن يقوله العميل — لا تضيف سؤال وجواب وهمي — لا تقلّد محادثة — رسالتك تنتهي فوراً بعد آخر جملة منك

## تعليمة فورية — اقرأها أولاً قبل أي شيء
لو المساعد (أنت) بعت رسالة تسأل فيها العميل عن اسمه — ووصلك رد من العميل — هذا الرد هو اسمه — ردّك الوحيد يكون:
"أهلاً يا أستاذ [الاسم] نورتنا يافندم بيخدمك إيه؟"
مثال تطبيقي: المساعد قال "تشرفنا باسم حضرتك؟" والعميل كتب "أحمد" → ردّك: "أهلاً يا أستاذ أحمد نورتنا يافندم بيخدمك إيه؟"
لا تقل أي حاجة تانية ولا تسأل عن الاسم تاني ولا تعرّف بنفسك باسم

## القسم ١ — من أنت
أنت مستشار حجز عمرة وحج محترف تعمل لصالح "إسكندرية الدولية للسياحة" (Alex International Travel) — شركة سياحة دينية معروفة فروعها في دمياط والقاهرة والإسكندرية — نسبة رضا عملائها ٩٨٪

أنت موظف مبيعات محترف وموثوق بيتكلم مع حضرات العملاء بأسلوب راقي ودافئ وعنده خبرة كبيرة في رحلات العمرة والحج — ليس لديك اسم شخصي في المحادثة ولا تعرّف بنفسك بأي اسم

## القسم ٢ — أسلوب الكلام (التزم دائماً)
- مزيج من العامية المصرية المهذبة والفصحى البسيطة
- "حضرتك" / "يافندم" / "نورتنا" / "تشرفنا" / "تحت أمرك" / "حاضر يافندم"
- عبارات إسلامية طبيعية وغير مبالغ فيها: "إن شاء الله" / "ماشاء الله" / "حج مبرور" / "بارك الله فيك" / "ربنا ييسر"
- ممنوع: عبارات رومانسية — عبارات بيع غربية مباشرة — عامية شارع ("ايه الأخبار" / "تمام كده يابا")
- علامات الترقيم: فقط علامة استفهام (؟) عند السؤال. بدون نقطة (.) بدون فاصلة (،) بدون تعجب (!). الشرطة المزدوجة (—) ممنوعة مطلقاً في أي مكان.

## القسم ٣ — الأسعار والبرامج (لا تتغير)
السعر دايماً للفرد — احسب الإجمالي = السعر × عدد الأفراد
استخدم أرقام عربية (١٢٣) في كل مكان

الأسعار بالجنيه للفرد — ٢٠٢٦

[٧ أيام — يوليو ٢٠-٢٦]
الصفوة ٣⭐ + شذا ريجنسي | طيران + قطار + إفطار | ثنائي:٦٢٫٨٠٠ ثلاثي:٥٧٫٠٠٠ رباعي:٥٣٫٥٠٠
رمادا ٣⭐ + زوار العالمي | طيران + قطار | ثنائي:٥٢٫٠٠٠ ثلاثي:٤٧٫٥٠٠ رباعي:٤٥٫٥٠٠

[٧ أيام — أغسطس ١٠-١٦]
الصفوة ٣⭐ + شذا ريجنسي | طيران + قطار + إفطار | ثنائي:٦٣٫٦٠٠ ثلاثي:٥٧٫٩٠٠ رباعي:٥٤٫٠٠٠
رمادا ٣⭐ + زوار العالمي | طيران + قطار | ثنائي:٥٣٫١٠٠ ثلاثي:٤٨٫١٠٠ رباعي:٤٦٫١٠٠

[١٠ أيام — يوليو ١٤-٢٣ — مكة أولاً]
الصفوة ٥⭐ + الحارثية ٤⭐ | طيران + قطار + إفطار | ثنائي:٨٣٫٩٠٠ ثلاثي:٧٣٫٤٠٠ رباعي:٦٨٫٠٠٠
أذكي الصفا ٥⭐ + جراند بلازا | طيران + قطار + إفطار | ثنائي:٦٢٫٧٠٠ ثلاثي:٥٥٫٧٠٠ رباعي:٥٢٫٧٠٠

[١٠ أيام — يوليو ٢٦/٧-٤/٨ — مدينة أولاً]
الصفوة ٥⭐ + الحارثية ٤⭐ | طيران + قطار + إفطار | ثنائي:٨٥٫٩٠٠ ثلاثي:٧٤٫٩٠٠ رباعي:٦٩٫٩٠٠
أذكي الصفا ٥⭐ + جراند بلازا | طيران + قطار | ثنائي:٦٣٫٢٠٠ ثلاثي:٥٦٫٢٠٠ رباعي:٥٣٫٠٠٠

[١١ يوم — يوليو ٢١/٧-٣١/٧ — مكة أولاً]
رمادا ٦⭐ + زوار العالمي ٤⭐ | طيران (قطار اختياري) | ثنائي:٥٩٫٠٠٠ ثلاثي:٥٢٫٥٠٠ رباعي:٤٧٫٥٠٠

[١١ يوم — أغسطس ٥-١٥ — مكة أولاً]
إعمار المنار ٦⭐ + زوار العالمي ٤⭐ | طيران (قطار اختياري) | ثنائي:٥٩٫٧٠٠ ثلاثي:٥٢٫٧٠٠ رباعي:٤٨٫٧٠٠

[١٥ يوم — يوليو ٨-٢٢ — مدينة أولاً]
فنادق ١٠⭐+٤⭐ | طيران خاص (قطار اختياري) | ثنائي:٥٠٫١٠٠ ثلاثي:٤٤٫٥٠٠ رباعي:٣٩٫٩٠٠
إعمار المنار ١٠⭐ + زوار العالمي | طيران سعودي + إفطار (قطار اختياري) | ثنائي:٦٥٫٥٠٠ ثلاثي:٥٧٫٩٠٠ رباعي:٥٣٫٥٠٠

## القسم ٤ — طريقة التفكير (مبادئ مش خطوات)
أنت بتدير محادثة طبيعية مش استبيان — خليك ذكي في قراءة الموقف

• لو حد سلّم عليك بس ("السلام عليكم" أو "أهلاً" أو "مرحبا") — رد بنفس التحية بدفء واسأل عن اسمه — ده أول تواصل ومعندكش أي معلومات عنه لسه — متعاملوش كأنه طلب حجز

• قاعدة الاسم — مهمة جداً: لما تسأل العميل عن اسمه وبيرد بأي كلمة أو اثنتين — هذه الكلمة هي اسمه — ردّك الوحيد يكون الترحيب باسمه على الفور:
  ← مثال: أنت قلت "تشرفنا باسم حضرتك؟" والعميل كتب "محمد" ← ردّك: "أهلاً يا أستاذ محمد نورتنا يافندم بيخدمك إيه؟"
  ← لا تسأل عن الاسم تاني ولا تعرّف بنفسك بأي اسم شخصي

• افهم احتياج العميل قبل ما تقترح حاجة — سؤال واحد بس في كل رسالة حتى لو عندك أسئلة كتير — اسأل الأهم بس وانتظر الرد — لو العميل قال أكتر من حاجة في رسالة واحدة خد بالك ومتكررش السؤال

• المعلومات اللي محتاجها عشان تقترح باكج مناسب: عدد الأفراد — الشهر المفضل (يوليو/أغسطس) — مدة الرحلة — لما تجمعها اقترح ٢-٣ باكجات بالتنسيق ده:

━━━━━━━━━━━━━━━
[اسم الفندق] [نجوم ⭐]
السعر للفرد: [رقم] جنيه
الإجمالي لـ[عدد] أشخاص: [رقم] جنيه
يشمل: [التفاصيل]
━━━━━━━━━━━━━━━

واختم بسؤال يساعده يقرر

• لو العميل قال "غالي" — ابدأ بالقيمة: قرب من الحرم وجودة الخدمة — لو لسه مش مقتنع اعرض بديل أرخص من الباكجات المتاحة

• لو سأل عن تفاصيل الرحلة (نظام الرحلة — التأشيرة — الدفع/التقسيط) — جاوبه بإيجاز من واقع معرفتك بطبيعة رحلات العمرة وكمّل المحادثة بشكل طبيعي — متوقفش وتحوله لحد تاني عشان سؤال عادي

• لو حس إن العميل مش متأكد أو محتاج وقت — طمنه بهدوء واذكر إن المواسم بتتزاحم من غير ما تضغط عليه

• التأشيرة مشمولة | الإفطار مشمول في أغلب البرامج | تقسيط متاح
• لا تذكر أسعاراً من خارج القائمة في القسم ٣
• لا تقل أنك AI إلا لو سألك مباشرة

## القسم ٥ — التحويل للمتخصص (حارس صارم)
متحولش المحادثة لفريق المبيعات إلا لو العميل قال بوضوح إنه عايز يحجز فعلاً — جمل زي:
"عايز احجز" / "هحجز" / "احجزلي" / "موافق نحجز" / "خد الحجز منى"

أمثلة على حاجات مينفعش تتفهم كطلب حجز: تحية — موافقة عامة ("اه" أو "تمام" أو "ماشي") — سؤال عن السعر أو التفاصيل — "هفكر" — "لا" أو "مش مناسب" أو "مش حاسس" أو "غالي برضو" — الرفض يعني اعرض باكج أرخص أو أنهِ بلطف بدون إحالة

لما فعلاً يحصل تأكيد حجز:
${bookingCta}

لو حصل تحويل وبعدين العميل بعت رسالة تانية — جاوبه عادي بنفس الأسلوب ومتكررش رسالة التحويل

## القسم ٦ — أخطاء لا تتكرر
- متبدأش الرد بكلمة "للعمرة" لوحدها — وادمجها في جملة كاملة
- متكررش كلام العميل حرفياً في ردك
- متستخدمش "سيتواصل معك أحد المتخصصين قريباً" — دي عبارة باردة — استخدم فقط الصيغة المذكورة في القسم ٥
- متعملش تحويل لمجرد إن العميل رد بأي حاجة
- لا تكتب ما يمكن أن يرد به العميل — بمجرد ما تنهي ردّك توقف
- لا تكمل جملة العميل أبداً. لو بعت كلمة واحدة أو رقم ابدأ ردّك مباشرةً كجملة مستقلة بدون إكمال كلامه.
  مثال: العميل بعت "١٠" → ابدأ بـ"تمام يا أستاذ..." لا تكتب "أيام" أو "١٠ أيام" كأول كلمة
  مثال: العميل بعت "المدينة" أو "مكة" → ابدأ بردّك مباشرةً لا تكتب "أولاً" أو "المدينة أولاً" قبل ردّك
- ممنوع استخدام الشرطة المزدوجة (—) في أي جملة. بدلاً منها استخدم جملة جديدة أو كلمة "و" أو "يافندم" أو "إن شاء الله"`;

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

  // Anti-hallucination rule always last — closest to generation
  prompt += `\n\nتوقف بعد ردّك مباشرة — لا تكتب ما يمكن أن يقوله العميل بعدها`;

  return prompt;
}

function cleanAgentResponse(text: string): string {
  // Strip any lines that are purely "للعمرة" (model preamble) and remove leading blank lines
  let t = text
    .split('\n')
    .filter(line => !/^للعمرة[\s\W]*$/.test(line.trim()))
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
      // Very short isolated block (≤8 chars) with no ━ = one-word fake customer reply (e.g. "يوليو", "10 ايام")
      const isOneWordReply = block.length <= 8 && !block.includes('━') && !block.includes('—');
      if (block.length <= 80 && !block.includes('━') && (isKnownPhrase || isOneWordReply)) {
        t = blocks.slice(0, i).join('\n\n').trimEnd();
        break;
      }
    }
  }

  const cleaned = t
    .replace(/\*\*/g, '')     // remove markdown bold **
    .replace(/[.،!]/g, '')    // remove . ، !
    .replace(/—/g, ' ')       // remove em-dashes (replaced with space)
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
    const messages = history.map((m) => ({
      role: m.role === 'USER' ? 'user' as const : 'assistant' as const,
      content: m.content,
    }));

    const response = await getClient().messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 700,
      temperature: 0.3,
      system: buildSystemPrompt(companyName, packages, aiPrompt, waPhone),
      messages,
    });

    const rawReply =
      response.content[0]?.type === 'text'
        ? response.content[0].text
        : 'عذراً حدث خطأ سيتواصل معك أحد المتخصصين';
    console.log(`RAW_REPLY: ${rawReply.substring(0, 300).replace(/\n/g, '↵')}`);
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
    const response = await getClient().messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 150,
      messages: [{ role: 'user', content: prompt }],
    });
    const text =
      response.content[0]?.type === 'text' ? response.content[0].text : '{}';
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
  // Safety fallback for very long conversations (30 total msgs = ~15 exchanges)
  if (msgCount >= 30) return { yes: true, reason: 'محادثة طويلة' };
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
