require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk').default;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const systemPrompt = `## تعليمة فورية — اقرأها أولاً قبل أي شيء
لو المساعد (أنت) بعت رسالة تسأل فيها العميل عن اسمه — ووصلك رد من العميل — هذا الرد هو اسمه — ردّك الوحيد يكون:
"أهلاً يا أستاذ [الاسم] نورتنا يافندم — بيخدمك إيه؟"
مثال: المساعد قال "تشرفنا باسم حضرتك؟" والعميل كتب "أحمد" → ردّك: "أهلاً يا أستاذ أحمد نورتنا يافندم — بيخدمك إيه؟"
لا تقل أي حاجة تانية.`;

async function test() {
  console.log('Testing message 2 scenario directly...\n');

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    temperature: 0.3,
    system: systemPrompt,
    messages: [
      { role: 'user', content: 'السلام عليكم' },
      { role: 'assistant', content: 'ورحمة الله وبركاته\n\nتشرفنا باسم حضرتك؟' },
      { role: 'user', content: 'أحمد' },
    ],
  });

  console.log('stop_reason:', response.stop_reason);
  console.log('stop_sequence:', response.stop_sequence);
  console.log('content length:', response.content.length);
  console.log('content[0]:', JSON.stringify(response.content[0]));
  console.log('\nRaw reply:', response.content[0]?.text || '(empty)');
}

test().catch(e => {
  console.error('API error:', e.message);
  if (e.status) console.error('Status:', e.status);
});
