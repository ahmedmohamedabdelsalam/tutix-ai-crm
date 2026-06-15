// Tests the optimized prompt directly via Anthropic SDK (no server needed)
// Runs same 5 journeys and collects TOKEN_USAGE for cost comparison
require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk').default;
const fs = require('fs');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const SYSTEM_PROMPT = fs.readFileSync('prompt-backup-optimized.txt', 'utf8');
const MODEL = process.env.AI_MODEL ?? 'claude-haiku-4-5-20251001';

let totalStats = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUSD: 0, messages: 0 };
let journeyStats = {};

async function chat(history, journeyLabel) {
  const messages = history.map(m => ({
    role: m.role === 'user' ? 'user' : 'assistant',
    content: m.content,
  }));

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1500,
    temperature: 0.3,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages,
  });

  const u = response.usage;
  const cr = u.cache_read_input_tokens ?? 0;
  const cw = u.cache_creation_input_tokens ?? 0;
  const cost = (u.input_tokens * 0.80 / 1e6) + (u.output_tokens * 4.00 / 1e6) + (cr * 0.08 / 1e6) + (cw * 1.00 / 1e6);

  console.log('TOKEN_USAGE:', JSON.stringify({
    journey: journeyLabel, msgCount: history.length,
    inputTokens: u.input_tokens, outputTokens: u.output_tokens,
    cacheReadTokens: cr, cacheWriteTokens: cw,
    estimatedCostUSD: cost.toFixed(6),
  }));

  totalStats.inputTokens += u.input_tokens;
  totalStats.outputTokens += u.output_tokens;
  totalStats.cacheReadTokens += cr;
  totalStats.cacheWriteTokens += cw;
  totalStats.costUSD += cost;
  totalStats.messages++;
  if (!journeyStats[journeyLabel]) journeyStats[journeyLabel] = { cost: 0, msgs: 0 };
  journeyStats[journeyLabel].cost += cost;
  journeyStats[journeyLabel].msgs++;

  return response.content[0]?.type === 'text' ? response.content[0].text : '';
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runJourney(label, userMessages) {
  console.log('\n' + '='.repeat(60));
  console.log('JOURNEY_START: ' + label);
  console.log('='.repeat(60));
  const history = [];
  for (let i = 0; i < userMessages.length; i++) {
    const msg = userMessages[i];
    console.log('\n--- MSG ' + (i+1) + '/' + userMessages.length + ': "' + msg + '" ---');
    history.push({ role: 'user', content: msg });
    const reply = await chat(history, label);
    history.push({ role: 'assistant', content: reply });
    console.log('REPLY: ' + reply.substring(0, 200).replace(/\n/g, '↵'));
    await sleep(300);
  }
  console.log('\nJOURNEY_END: ' + label);
}

async function main() {
  console.log('OPTIMIZED PROMPT COST TEST — ' + MODEL);
  console.log('Prompt: prompt-backup-optimized.txt');
  console.log('Pricing: $0.80/M input | $4.00/M output | $0.08/M cache-read | $1.00/M cache-write\n');

  await runJourney('A-SHORT', [
    'السلام عليكم',
    'أحمد',
    'عمرة',
    'يوليو',
    'اقتصادي',
    'عايز أحجز',
  ]);
  await sleep(1000);

  await runJourney('B-MEDIUM', [
    'السلام عليكم',
    'سارة',
    'عمرة',
    'اتنين',
    'أغسطس',
    'خمس نجوم',
    'وريني البرامج',
    'مفيش أرخص؟',
    'هفكر',
    'ماشي',
  ]);
  await sleep(1000);

  await runJourney('C-LONG', [
    'السلام عليكم',
    'محمود',
    'حج',
    '3 أفراد',
    'اقتصادي',
    'وريني البرامج',
    'ليه أحج معاكم؟',
    'فيه تقسيط؟',
    'شفت برنامج أرخص',
    'الأضحية بكام؟',
    'هل الأكل مشمول؟',
    'والدي كبير في السن',
    'تمام هفكر',
    'ماشي',
    'شكراً',
  ]);
  await sleep(1000);

  await runJourney('D-FAQ', [
    'السلام عليكم',
    'كريم',
    'حج',
    'ليه أحج معاكم؟',
    'الفرق بين التمتع والقران؟',
    'المخيمات إيه الفرق؟',
    'شفت برنامج أرخص بـ 30 ألف',
    'هفكر',
  ]);
  await sleep(1000);

  await runJourney('E-SHORT-RETURN', [
    'السلام عليكم',
    'ممكن تكتب',
    'محمود',
    'عمرة سبتمبر',
    'خمس نجوم',
  ]);

  console.log('\n' + '='.repeat(60));
  console.log('OPTIMIZED SUMMARY');
  console.log('='.repeat(60));
  for (const [label, s] of Object.entries(journeyStats)) {
    console.log('Journey ' + label + ': $' + s.cost.toFixed(6) + ' (' + s.msgs + ' msgs)');
  }
  console.log('\nTOTAL_OPTIMIZED:', JSON.stringify({
    messages: totalStats.messages,
    inputTokens: totalStats.inputTokens,
    outputTokens: totalStats.outputTokens,
    cacheReadTokens: totalStats.cacheReadTokens,
    cacheWriteTokens: totalStats.cacheWriteTokens,
    totalCostUSD: totalStats.costUSD.toFixed(6),
  }));
}

main().catch(console.error);
