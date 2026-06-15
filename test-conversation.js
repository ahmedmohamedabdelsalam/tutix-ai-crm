const http = require('http');
const PHONE = '20100000099'; // isolated test phone

async function send(message) {
  return new Promise((resolve) => {
    const data = JSON.stringify({ phone: PHONE, message });
    const req = http.request({
      hostname: 'localhost', port: 3001, path: '/webhook/test',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({ reply: body }); } });
    });
    req.on('error', e => resolve({ error: e.message }));
    req.write(data); req.end();
  });
}

async function main() {
  const steps = [
    'السلام عليكم',
    'أحمد',
    'اتفضل',
    'شخصين انا وزوجتي',
    'أغسطس',
    '٧ أيام',
    'غالي شويه',
  ];

  console.log('=== Test Conversation ===\n');
  for (const msg of steps) {
    const r = await send(msg);
    console.log(`USER  : ${msg}`);
    console.log(`AGENT : ${r.reply ?? JSON.stringify(r)}`);
    console.log('---');
    await new Promise(res => setTimeout(res, 1200));
  }
}

main();
