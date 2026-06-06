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

function buildSystemPrompt(companyName: string, packages: string, aiPrompt: string): string {
  let prompt = `أنت مستشار حجوزات محترف في شركة "${companyName}" لخدمات الحج والعمرة.

مهمتك الأساسية: مساعدة العميل في اختيار الباكج المناسب وإقناعه بالحجز، ثم تحويله لفريق المبيعات لإتمام الإجراءات.

--- الأسلوب ---
- احترافي ومؤدب ودافئ في آنٍ واحد
- استخدم الفصحى البسيطة المفهومة
- لا تستخدم رموزاً تعبيرية أو إيموجي أبداً
- اسأل سؤالاً واحداً فقط في كل رسالة
- ردودك موجزة لا تتجاوز أربعة أسطر
- لا تسرد قائمة بالباكجات دفعةً واحدة — قدِّمها تدريجياً حسب احتياج العميل

--- خطوات البيع (اتبعها بالترتيب) ---
الخطوة 1 — الترحيب: رحّب بالعميل باسم الشركة واسأله هل يريد الحج أم العمرة.
الخطوة 2 — عدد الأفراد: اسأل عن عدد الأفراد (كبار + أطفال) لتحديد السعر المناسب.
الخطوة 3 — عرض الباكجات: قدِّم باكجَين أو ثلاثة مناسبة مع حساب السعر الإجمالي للمجموعة. مثال: "باكج X بـ Y جنيه للفرد، إجمالي لـ N أفراد = Z جنيه."
الخطوة 4 — التفضيل: اسأل أيّ الباكجات يناسبه أكثر.
الخطوة 5 — موعد السفر: اسأل عن التاريخ أو الشهر المفضّل للسفر.
الخطوة 6 — تأكيد الميزانية: إذا أبدى اهتماماً، اسأل بلطف هل الميزانية المذكورة مناسبة له.
الخطوة 7 — الإغلاق: إذا كان العميل مهتماً وجاهزاً، قل له: "سيتصل بك أحد مستشارينا لإتمام الحجز وتأكيد المقعد."

--- التعامل مع الاعتراضات ---
- إذا قال السعر مرتفع: اعرض باكجاً أوفر أو قل إن هناك تقسيطاً متاحاً (إن وُجد في الباكجات).
- إذا قال سيفكر: ذكِّره بمحدودية المقاعد بأسلوب هادئ غير ضاغط.
- إذا طلب تفاصيل أكثر: أجب باختصار ثم عُد لسؤاله عن قراره.

--- الباكجات المتاحة ---
${packages}`;

  if (aiPrompt) {
    prompt += `\n\n--- تعليمات إضافية من الشركة ---\n${aiPrompt}`;
  }

  return prompt;
}

export async function getAgentReply(
  history: { role: string; content: string }[],
  companyName: string,
  packages: string,
  aiPrompt = '',
): Promise<string> {
  try {
    const res = await getClient().chat.completions.create({
      model: getModel(),
      messages: [
        { role: 'system', content: buildSystemPrompt(companyName, packages, aiPrompt) },
        ...history.map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        })),
      ],
      temperature: 0.7,
      max_tokens: 300,
    });
    return (
      res.choices[0].message.content ??
      'عذراً، حدث خطأ. سيتواصل معك أحد المتخصصين.'
    );
  } catch (err) {
    console.error('AI error:', err);
    return 'عذراً، حدث خطأ. سيتواصل معك أحد المتخصصين قريباً.';
  }
}

export async function extractLeadData(
  history: { role: string; content: string }[],
): Promise<Partial<LeadData>> {
  const prompt = `من المحادثة التالية استخرج بيانات العميل. أجب بـ JSON فقط:
{"name":"الاسم أو null","packageType":"حج أو عمرة أو null","groupSize":عدد أو null,"budget":"الميزانية أو null","travelDate":"الموعد أو null","isReadyToBook":true أو false}
المحادثة:
${history.map((m) => `${m.role === 'user' ? 'العميل' : 'المساعد'}: ${m.content}`).join('\n')}`;

  try {
    const res = await getClient().chat.completions.create({
      model: getModel(),
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      max_tokens: 200,
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

export function shouldHandoff(
  score: number,
  msgCount: number,
  data: Partial<LeadData>,
): { yes: boolean; reason: string } {
  if (data.isReadyToBook) return { yes: true, reason: 'العميل جاهز للحجز' };
  if (score >= 70) return { yes: true, reason: `score عالي (${score}/100)` };
  if (msgCount >= 10) return { yes: true, reason: 'محادثة طويلة' };
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
