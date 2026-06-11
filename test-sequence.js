require('dotenv').config();
const http = require('http');

const PHONE = '20100000099';
const DELAY = 3000;

const messages = [
  'السلام عليكم',
  'احمد',
  'بدور علي الحج',
  '2',
  'يوليو كويس',
  '10',
  'المدينه',
  'حاسس غالي شويه',
  'لا برضو مش حاسس',
  'انا قولت مش مناسب',
];

function send(msg) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ phone: PHONE, message: msg });
    const req = http.request({
      hostname: 'localhost', port: 3001,
      path: '/webhook/test', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ raw: data }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function run() {
  console.log('=== 7-Step Conversation Test ===\n');
  for (let i = 0; i < messages.length; i++) {
    console.log(`[${i + 1}] العميل: ${messages[i]}`);
    try {
      const result = await send(messages[i]);
      const reply = result.reply || result.raw || JSON.stringify(result);
      console.log(`    الوكيل: ${reply}`);
    } catch (e) {
      console.log(`    ERROR: ${e.message}`);
    }
    console.log('');
    if (i < messages.length - 1) await sleep(DELAY);
  }
  console.log('=== Test Complete ===');
}

run().catch(console.error);
