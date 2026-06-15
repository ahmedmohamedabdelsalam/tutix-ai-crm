require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk').default;
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const history = [
  { role: 'user', content: 'السلام عليكم' },
  { role: 'assistant', content: 'ورحمة الله وبركاته\n\nتشرفنا باسم حضرتك؟' },
  { role: 'user', content: 'أحمد' },
];

async function testPrompt(label, systemPrompt) {
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 150,
    temperature: 0.3,
    system: systemPrompt,
    messages: history,
  });
  const text = response.content[0]?.text || '(EMPTY)';
  console.log(`[${label}] content_len=${response.content.length} reply="${text.substring(0,80)}"`);
}

const sec1 = `## تعليمة فورية
لو بعت رسالة تسأل العميل عن اسمه ووصلك رد — هذا الرد هو اسمه — ردّك: "أهلاً يا أستاذ [الاسم] نورتنا يافندم — بيخدمك إيه؟"`;

const sec2 = `## القسم ١ — من أنت
أنت مستشار حجز عمرة وحج محترف تعمل لصالح "إسكندرية الدولية للسياحة" — فروعها في دمياط والقاهرة والإسكندرية — نسبة رضا عملائها ٩٨٪`;

const sec3 = `## القسم ٢ — أسلوب الكلام
- "حضرتك" / "يافندم" / "نورتنا" / "تشرفنا"
- عبارات إسلامية طبيعية: "إن شاء الله" / "ماشاء الله"
- علامات الترقيم: بدون نقطة (.) وبدون فاصلة (،) وبدون علامة تعجب (!)`;

const packages = `## القسم ٣ — الأسعار والبرامج
[٧ أيام — يوليو ٢٠-٢٦]
الصفوة ٣⭐ + شذا ريجنسي | طيران + قطار + إفطار | ثنائي:٦٢٫٨٠٠ ثلاثي:٥٧٫٠٠٠ رباعي:٥٣٫٥٠٠
رمادا ٣⭐ + زوار العالمي | طيران + قطار | ثنائي:٥٢٫٠٠٠ ثلاثي:٤٧٫٥٠٠ رباعي:٤٥٫٥٠٠
[١٠ أيام — يوليو ١٤-٢٣ — مكة أولاً]
الصفوة ٥⭐ + الحارثية ٤⭐ | طيران + قطار + إفطار | ثنائي:٨٣٫٩٠٠ ثلاثي:٧٣٫٤٠٠ رباعي:٦٨٫٠٠٠`;

async function run() {
  await testPrompt('sec1 only', sec1);
  await testPrompt('sec1+2', [sec1,sec2].join('\n\n'));
  await testPrompt('sec1+2+3', [sec1,sec2,sec3].join('\n\n'));
  await testPrompt('sec1+2+3+packages', [sec1,sec2,sec3,packages].join('\n\n'));
}

run().catch(e => console.error(e.message));
