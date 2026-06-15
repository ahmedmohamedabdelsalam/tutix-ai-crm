// Test: same phone gets exactly ONE Lead after two separate conversations
require('dotenv').config();
const http  = require('http');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const PHONE = '20100000099';

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

async function countLeads() {
  const { rows } = await pool.query(
    `SELECT COUNT(*) AS c FROM "Lead" WHERE phone = $1`, [PHONE]
  );
  return parseInt(rows[0].c);
}

async function closeConversation() {
  const { rowCount } = await pool.query(
    `UPDATE "Conversation" SET status = 'CLOSED'
     WHERE phone = $1 AND status != 'CLOSED'`, [PHONE]
  );
  return rowCount;
}

async function getLeadName() {
  const { rows } = await pool.query(
    `SELECT name FROM "Lead" WHERE phone = $1 ORDER BY "createdAt" ASC LIMIT 1`, [PHONE]
  );
  return rows[0]?.name ?? null;
}

async function clearTestPhone() {
  await pool.query(`DELETE FROM "Message" WHERE "conversationId" IN (
    SELECT id FROM "Conversation" WHERE phone = $1)`, [PHONE]);
  await pool.query(`DELETE FROM "Conversation" WHERE phone = $1`, [PHONE]);
  await pool.query(`DELETE FROM "Lead" WHERE phone = $1`, [PHONE]);
}

async function main() {
  await clearTestPhone();
  console.log('[SETUP] Cleared existing data for test phone', PHONE);

  // ── Conversation 1 ───────────────────────────────────────────────────────
  console.log('\n=== Conversation 1 ===');
  let r = await send('السلام عليكم');
  console.log(`USER : السلام عليكم\nAGENT: ${r.reply}`);
  await new Promise(res => setTimeout(res, 800));

  r = await send('محمد');
  console.log(`USER : محمد\nAGENT: ${r.reply}`);
  await new Promise(res => setTimeout(res, 800));

  r = await send('عايز استفسر عن رحلة عمرة');
  console.log(`USER : عايز استفسر عن رحلة عمرة\nAGENT: ${r.reply}`);

  const leadsAfterConv1 = await countLeads();
  const nameAfterConv1  = await getLeadName();
  console.log(`\n[CHECK 1] Leads count: ${leadsAfterConv1}  |  Lead.name: "${nameAfterConv1}"`);

  // ── Close conversation (simulate end of session) ──────────────────────
  const closed = await closeConversation();
  console.log(`[SETUP] Closed ${closed} conversation(s)`);

  // ── Conversation 2 (same phone, new session) ─────────────────────────
  await new Promise(res => setTimeout(res, 600));
  console.log('\n=== Conversation 2 (same phone) ===');
  r = await send('السلام عليكم');
  console.log(`USER : السلام عليكم\nAGENT: ${r.reply}`);
  await new Promise(res => setTimeout(res, 600));

  const leadsAfterConv2 = await countLeads();
  console.log(`\n[CHECK 2] Leads count after 2nd conversation: ${leadsAfterConv2}`);

  // ── Verdict ──────────────────────────────────────────────────────────
  console.log('\n════════════════════════════════');
  if (leadsAfterConv2 === 1) {
    console.log('PASS — exactly 1 Lead for phone', PHONE);
  } else {
    console.log(`FAIL — found ${leadsAfterConv2} leads (expected 1)`);
  }

  // Check AI greeted by name in conv 2 (should NOT ask "تشرفنا باسم حضرتك")
  if (r.reply && r.reply.includes('محمد')) {
    console.log('PASS — AI greeted by name in conv 2');
  } else if (r.reply && r.reply.includes('باسم حضرتك')) {
    console.log('FAIL — AI asked for name again in conv 2');
  } else {
    console.log('INFO — AI response in conv 2:', r.reply);
  }
  console.log('════════════════════════════════\n');

  await pool.end();
}

main().catch(e => { console.error(e); pool.end(); });
