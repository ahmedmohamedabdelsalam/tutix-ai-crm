// Tests two follow-up scheduling scenarios:
// Scenario A: customer agrees to agent's proposal → followUpStatus=SCHEDULED
// Scenario B: customer declines ("أنا هكلمك") → followUpStatus stays NONE
require('dotenv').config();
const http = require('http');
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const BASE_MSGS = [
  'السلام عليكم',
  'أحمد',
  'أنا وزوجتي عايزين عمرة في يوليو',
  'اتنين',
  '٧ أيام',
  'من مكة',
  'خليني افكر وارد عليك',  // agent should propose "بكرة"
];

function post(phone, message) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ phone, message });
    const req = http.request(
      { hostname: 'localhost', port: 3001, path: '/webhook/test', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve(JSON.parse(d))); }
    );
    req.on('error', reject);
    req.write(body); req.end();
  });
}

function postRaw(path, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload || {});
    const req = http.request(
      { hostname: 'localhost', port: 3001, path, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try{resolve(JSON.parse(d))}catch{resolve(d)} }); }
    );
    req.on('error', reject);
    req.write(body); req.end();
  });
}

async function getConv(phone) {
  const { rows } = await pool.query(
    `SELECT id, "followUpStatus", "followUpScheduledAt" FROM "Conversation" WHERE phone=$1 ORDER BY "createdAt" DESC LIMIT 1`,
    [phone]
  );
  return rows[0] || null;
}

async function scenario(label, phone, finalMsg) {
  console.log(`\n${'═'.repeat(55)}`);
  console.log(`SCENARIO ${label}`);
  console.log(`${'═'.repeat(55)}`);

  for (const msg of BASE_MSGS) {
    const r = await post(phone, msg);
    const parts = r.parts || [];
    console.log(`USER: ${msg}`);
    parts.forEach((p, i) => console.log(`  BOT [${i+1}]: ${p}`));
    await new Promise(r => setTimeout(r, 800));
  }

  console.log(`\n>>> Final message: "${finalMsg}"`);
  const r = await post(phone, finalMsg);
  const parts = r.parts || [];
  parts.forEach((p, i) => console.log(`  BOT [${i+1}]: ${p}`));

  await new Promise(r => setTimeout(r, 500));
  const conv = await getConv(phone);
  console.log(`\nDB state:`);
  console.log(`  followUpStatus:      ${conv?.followUpStatus ?? 'N/A'}`);
  console.log(`  followUpScheduledAt: ${conv?.followUpScheduledAt ?? 'null'}`);
  return conv;
}

async function run() {
  // Scenario A: customer agrees → should schedule
  const convA = await scenario('A — agrees to follow-up', '201111111181', 'ماشي');

  // Scenario B: customer declines → should NOT schedule
  const convB = await scenario('B — declines follow-up', '201111111182', 'لأ أنا هكلمك');

  console.log(`\n${'═'.repeat(55)}`);
  console.log('RESULTS');
  console.log(`${'═'.repeat(55)}`);
  const aOk = convA?.followUpStatus === 'SCHEDULED';
  const bOk = convB?.followUpStatus === 'NONE' || convB?.followUpStatus == null;
  console.log(`A (agree)  → followUpStatus=${convA?.followUpStatus}  ${aOk ? '✓ PASS' : '✗ FAIL'}`);
  console.log(`B (decline) → followUpStatus=${convB?.followUpStatus}  ${bOk ? '✓ PASS' : '✗ FAIL'}`);

  if (aOk) {
    // Backdate A's followUpScheduledAt to epoch (clearly in the past) so cron fires it
    await pool.query(
      `UPDATE "Conversation" SET "followUpScheduledAt"=$1 WHERE id=$2`,
      [new Date(0), convA.id]
    );
    // Verify backdate worked
    const check = await getConv('201111111181');
    console.log(`\nBackdated → followUpScheduledAt=${check?.followUpScheduledAt?.toISOString() ?? 'null'}, status=${check?.followUpStatus}`);

    console.log(`Triggering cron (force=bypass window)...`);
    const cronResult = await postRaw('/webhook/test-followup', {});
    console.log(`Cron result:`, JSON.stringify(cronResult, null, 2));

    // Check final status
    const convAfter = await getConv('201111111181');
    console.log(`After cron: followUpStatus=${convAfter?.followUpStatus}  ${convAfter?.followUpStatus === 'SENT' ? '✓ PASS' : '✗ FAIL'}`);
  }

  await pool.end();
}

run().catch(e => { console.error(e); pool.end(); });
