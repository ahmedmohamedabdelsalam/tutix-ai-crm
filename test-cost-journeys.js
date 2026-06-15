// Cost analysis test — runs 5 WhatsApp journeys against localhost:3001
// Each journey uses a unique phone to avoid session bleed
const http = require('http');

function send(phone, message) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ phone, message });
    const req = http.request({
      hostname: 'localhost', port: 3001,
      path: '/webhook/test', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const DELAY = 1200; // ms between messages (let server finish async work)

async function runJourney(label, phone, messages) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`JOURNEY_START: ${label} | phone=${phone}`);
  console.log('='.repeat(60));
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    console.log(`\n--- MSG ${i + 1}/${messages.length}: "${msg}" ---`);
    try {
      const res = await send(phone, msg);
      console.log(`REPLY: ${JSON.stringify(res.reply ?? res).substring(0, 200)}`);
    } catch (e) {
      console.error(`ERROR at msg ${i + 1}:`, e.message);
    }
    if (i < messages.length - 1) await sleep(DELAY);
  }
  console.log(`\nJOURNEY_END: ${label}`);
}

async function main() {
  console.log('TOKEN COST ANALYSIS — starting 5 journeys');
  console.log('Model: claude-haiku-4-5-20251001');
  console.log('Pricing: $0.80/M input | $4.00/M output | $0.08/M cache-read | $1.00/M cache-write\n');

  // Journey A — Short (6 msgs, ends with booking intent)
  await runJourney('A-SHORT', '01300000101', [
    'السلام عليكم',
    'أحمد',
    'عمرة',
    'يوليو',
    'اقتصادي',
    'عايز أحجز',
  ]);
  await sleep(2000);

  // Journey B — Medium (10 msgs, negotiation)
  await runJourney('B-MEDIUM', '01300000102', [
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
  await sleep(2000);

  // Journey C — Long (15 msgs)
  await runJourney('C-LONG', '01300000103', [
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
  await sleep(2000);

  // Journey D — FAQ heavy (8 msgs)
  await runJourney('D-FAQ', '01300000104', [
    'السلام عليكم',
    'كريم',
    'حج',
    'ليه أحج معاكم؟',
    'الفرق بين التمتع والقران؟',
    'المخيمات إيه الفرق؟',
    'شفت برنامج أرخص بـ 30 ألف',
    'هفكر',
  ]);
  await sleep(2000);

  // Journey E — Short return (5 msgs, simulate returning customer by name)
  await runJourney('E-SHORT-RETURN', '01300000105', [
    'السلام عليكم',
    'ممكن تكتب',
    'محمود',
    'عمرة سبتمبر',
    'خمس نجوم',
  ]);

  console.log('\n' + '='.repeat(60));
  console.log('ALL JOURNEYS COMPLETE — check server log for TOKEN_USAGE lines');
  console.log('='.repeat(60));
}

main().catch(console.error);
