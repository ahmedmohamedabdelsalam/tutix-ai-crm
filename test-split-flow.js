// Tests message splitting: package card replies and short closing replies.
// Shows parts[] from the test endpoint to verify split logic.
const http = require('http');
const PHONE = '201111111199';

const MESSAGES = [
  'السلام عليكم',
  'سارة',
  'أنا وجوزي عايزين عمرة في يوليو',
  'اتنين',
  '٧ أيام',                     // → should trigger package card reply
  'خليني افكر وارد عليك',      // → should split into 1-2 short messages
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
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve({ reply: data, parts: [] }); } });
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
    console.log(`\n═══ MSG ${i + 1}: "${msg}" ═══`);
    const res = await post(PHONE, msg);
    const parts = res.parts ?? [];
    console.log(`BOT (${parts.length} part${parts.length !== 1 ? 's' : ''}):`);
    if (parts.length > 0) {
      parts.forEach((p, pi) => console.log(`  [${pi + 1}] ${p}`));
    } else {
      console.log(`  ${res.reply}`);
    }
    await new Promise(r => setTimeout(r, 1000));
  }
}

run().catch(console.error);
