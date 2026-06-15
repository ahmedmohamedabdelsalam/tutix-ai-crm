// Tests 7 sequential messages and prints replies.
// Run AFTER starting the dev server and clearing test data.
// Server logs (EXTRACT: lines) visible in server.log.
const http = require('http');

const PHONE = '201234567890';
const MESSAGES = [
  'السلام عليكم',                              // msg 1 → runExtract=true (<=2)
  'أحمد',                                       // msg 2 → runExtract=true (<=2 or mod3)
  'أنا وزوجتي عايزين نعمل عمرة',              // msg 3 → runExtract=false
  'يوليو أو أغسطس',                            // msg 4 → runExtract=false
  'ميزانيتنا حوالي ١٢٠ ألف للاتنين',         // msg 5 → runExtract=false
  'طيب ابعتلي الأسعار',                        // msg 6 → runExtract=true (mod3, len=9? or near)
  'عايز احجز',                                 // msg 7 → runExtract=true (booking signal)
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
    try {
      const res = await post(PHONE, msg);
      console.log(`BOT:  ${res.reply}`);
    } catch (e) {
      console.error(`ERROR: ${e.message}`);
    }
    // Small delay so server logs flush in order
    await new Promise(r => setTimeout(r, 1500));
  }
  console.log('\n─── Done. Check server.log for EXTRACT: lines ───');
}

run();
