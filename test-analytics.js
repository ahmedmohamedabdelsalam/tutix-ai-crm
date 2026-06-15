require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const CID = process.env.DEFAULT_COMPANY_ID;

async function send(phone, msg) {
  const r = await fetch('http://localhost:3001/webhook/test', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, message: msg })
  });
  const j = await r.json();
  return j.reply ?? j.error ?? '';
}

function pass(s) { console.log('  PASS:', s); }
function fail(s, e) { console.log('  FAIL:', s); if (e) console.log('      >', e); }

async function getInsights() {
  const r = await pool.query(
    'SELECT type, category, content FROM "AgentInsight" WHERE "companyId" = $1 ORDER BY "createdAt" ASC',
    [CID]
  );
  return r.rows;
}

async function run() {
  // CONV 1: goes silent after price cards
  console.log('=== CONV 1: Silent after price ===');
  const P1 = '201111000001';
  await send(P1, 'السلام عليكم');
  await send(P1, 'كريم');
  await send(P1, 'عايز عمرة يوليو لشخصين');
  const r1 = await send(P1, '7 أيام');
  console.log('  last reply:', r1.substring(0, 120));

  // CONV 2: handoff after booking intent
  console.log('');
  console.log('=== CONV 2: Handoff ===');
  const P2 = '201111000002';
  await send(P2, 'السلام عليكم');
  await send(P2, 'منى');
  await send(P2, 'عمرة أغسطس ثلاثة أشخاص');
  await send(P2, '11 يوم');
  const r2 = await send(P2, 'تمام موافقة احجزلي');
  console.log('  handoff reply:', r2.substring(0, 120));

  // CONV 3: silent after greeting (only one message)
  console.log('');
  console.log('=== CONV 3: Silent after greeting ===');
  const P3 = '201111000003';
  const r3 = await send(P3, 'السلام عليكم');
  console.log('  greeting reply:', r3.substring(0, 100));

  // CONV 4: deferred question
  console.log('');
  console.log('=== CONV 4: Deferred question ===');
  const P4 = '201111000004';
  await send(P4, 'السلام عليكم');
  await send(P4, 'طارق');
  const r4 = await send(P4, 'هل يشمل البرنامج التأمين الصحي؟');
  console.log('  deferred reply:', r4.substring(0, 200));

  // Trigger drop-off analysis (bypasses 2h threshold)
  console.log('');
  console.log('=== Triggering cron (bypasses 2h) ===');
  const tr = await fetch('http://localhost:3001/webhook/test-followup', { method: 'POST' });
  const tj = await tr.json();
  console.log('  cron result:', JSON.stringify(tj));

  // Verify AgentInsight records
  console.log('');
  console.log('=== AgentInsight records ===');
  const insights = await getInsights();
  console.log('  Total records:', insights.length);
  insights.forEach((ins, i) => {
    const preview = ins.content ? ins.content.substring(0, 60) : '-';
    console.log(`  [${i+1}] type=${ins.type} | cat=${ins.category ?? '-'} | content="${preview}"`);
  });

  const dropOffs = insights.filter(i => i.type === 'drop_off_stage');
  const deferred = insights.filter(i => i.type === 'deferred_question');

  dropOffs.length >= 2
    ? pass(`${dropOffs.length} drop-off records created`)
    : fail('Expected >=2 drop-off records', JSON.stringify(dropOffs));

  const hasPrice    = dropOffs.some(d => d.category === 'بعد عرض الأسعار');
  const hasGreeting = dropOffs.some(d => d.category === 'بعد التحية / السؤال عن الاسم');
  hasPrice    ? pass('Drop-off after-price detected for CONV 1')   : fail('Missing after-price drop-off', JSON.stringify(dropOffs.map(d=>d.category)));
  hasGreeting ? pass('Drop-off after-greeting detected for CONV 3') : fail('Missing after-greeting drop-off', JSON.stringify(dropOffs.map(d=>d.category)));

  // CONV 2 should NOT be a drop-off (it's NEEDS_HUMAN)
  const c2r = await pool.query('SELECT status FROM "Conversation" WHERE phone=$1 AND "companyId"=$2', [P2, CID]);
  const c2 = c2r.rows[0];
  c2 && c2.status === 'NEEDS_HUMAN'
    ? pass('CONV 2 is NEEDS_HUMAN — correctly excluded from drop-off analysis')
    : fail('CONV 2 status unexpected: ' + JSON.stringify(c2));

  deferred.length > 0
    ? pass(`${deferred.length} deferred_question record(s) logged`)
    : console.log('  INFO: no deferred records — AI did not use deferral phrase for this question');

  await pool.end();
}
run().catch(e => { console.error(e.message); pool.end(); });
