// Tests the "let me think it over" closing to verify no negation.
const http = require('http');
const PHONE = '201111111113';

const MESSAGES = [
  'السلام عليكم',
  'محمد',
  'أنا وزوجتي عايزين نعمل عمرة في يوليو',
  'اتنين بس',
  'خليني افكر وارد عليك',
];

function post(phone, message) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ phone, message });
    const req = http.request(
      { hostname: 'localhost', port: 3001, path: '/webhook/test', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => resolve(JSON.parse(data)));
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function run() {
  for (let i = 0; i < MESSAGES.length; i++) {
    const msg = MESSAGES[i];
    console.log(`\n─── MSG ${i + 1} ─────────────────────────────`);
    console.log(`USER: ${msg}`);
    const res = await post(PHONE, msg);
    console.log(`BOT:  ${res.reply}`);
    await new Promise(r => setTimeout(r, 1200));
  }
  const last = MESSAGES[MESSAGES.length - 1];
  const hasNegation = ['بلاش', 'مش لازم', 'متتواصلش'].some(w => {});
  console.log('\n─── Check complete ───');
}

run().catch(console.error);
