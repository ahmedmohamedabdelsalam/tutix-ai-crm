const Anthropic = require('@anthropic-ai/sdk').default;
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
async function main() {
  const res = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    system: 'أنت موظف مبيعات محترف في شركة سياحة مصرية متخصصة في رحلات الحج والعمرة. ردّ دائماً بالعربية.',
    messages: [{ role: 'user', content: 'السلام عليكم' }],
  });
  console.log('REPLY:', res.content[0].text);
  console.log('USAGE:', JSON.stringify(res.usage));
}
main().catch(e => console.error('ERROR:', e.message));
