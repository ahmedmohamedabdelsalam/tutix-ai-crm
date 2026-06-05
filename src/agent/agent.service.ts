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

function buildSystemPrompt(companyName: string, packages: string): string {
  return `أنت مساعد ذكي لشركة "${companyName}" لخدمات الحج والعمرة.
مهمتك التحدث مع العملاء بشكل طبيعي وجمع بياناتهم.
البيانات المطلوبة: الاسم - نوع الخدمة (حج/عمرة) - عدد الأفراد - الميزانية - موعد السفر
الباكجات: ${packages}
قواعد: تكلم بالعربية دائماً - اسأل سؤال واحد في كل رسالة - لو العميل جاهز للحجز قوله سيتواصل معه متخصص`;
}

export async function getAgentReply(
  history: { role: string; content: string }[],
  companyName: string,
  packages: string,
): Promise<string> {
  try {
    const res = await getClient().chat.completions.create({
      model: getModel(),
      messages: [
        { role: 'system', content: buildSystemPrompt(companyName, packages) },
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
      'عذراً حدث خطأ، سيتواصل معك أحد المتخصصين.'
    );
  } catch (err) {
    console.error('AI error:', err);
    return 'عذراً حدث خطأ، سيتواصل معك أحد المتخصصين قريباً.';
  }
}

export async function extractLeadData(
  history: { role: string; content: string }[],
): Promise<Partial<LeadData>> {
  const prompt = `من المحادثة دي استخرج بيانات العميل. أجب بـ JSON فقط:
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
