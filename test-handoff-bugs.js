require('dotenv').config()
const { Pool } = require('pg')
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const CID = process.env.DEFAULT_COMPANY_ID
const BASE = 'http://localhost:3001'

async function send(phone, msg) {
  const r = await fetch(`${BASE}/webhook/test`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, message: msg }),
  })
  const j = await r.json()
  return j.reply ?? j.error ?? ''
}

async function clearPhone(phone) {
  const c = await pool.query(`SELECT id FROM "Conversation" WHERE phone=$1 AND "companyId"=$2`, [phone, CID])
  for (const row of c.rows) {
    await pool.query(`DELETE FROM "Message" WHERE "conversationId"=$1`, [row.id])
    await pool.query(`DELETE FROM "Conversation" WHERE id=$1`, [row.id])
  }
  await pool.query(`DELETE FROM "Lead" WHERE phone=$1 AND "companyId"=$2`, [phone, CID])
}

function pass(msg) { console.log('  ✓ PASS:', msg) }
function fail(msg, got) { console.log('  ✗ FAIL:', msg); if (got) console.log('       got:', got.substring(0, 300)) }

async function run() {
  const P = '201000010001'
  console.log('\n=== Clearing (ensure no existing Lead) ===')
  await clearPhone(P)

  // MSG 1: Service inquiry — no name known — should ask for name
  console.log('\n=== MSG 1: "لو سمحت كنت عايز أسأل عن العمرة" ===')
  const r1 = await send(P, 'لو سمحت كنت عايز أسأل عن العمرة')
  console.log('  Reply:', r1)
  const asksName   = /تشرفنا|باسم حضرتك|اسمك|اسم/.test(r1)
  const noFakeName = !/أستاذ أحمد|يا أحمد/.test(r1)
  const noHandoff  = !/هحول|زميلي المختص/.test(r1)
  asksName   ? pass('Asks for customer name') : fail('Did NOT ask for name', r1)
  noFakeName ? pass('No phantom name used') : fail('Used a name it does not know yet', r1)
  noHandoff  ? pass('No handoff on first message') : fail('Handoff fired on first message', r1)

  // MSG 2: Customer sends their name — should greet + continue flow (NOT handoff)
  console.log('\n=== MSG 2: "أحمد" (customer giving name) ===')
  const r2 = await send(P, 'أحمد')
  console.log('  Reply:', r2)
  const greetsName   = /أحمد/.test(r2)
  const continuesFlow = /شخص|أفراد|شهر|يوليو|أغسطس|مستوى|برنامج|عمرة|حج/.test(r2)
  const noHandoff2   = !/هحول|زميلي المختص|٠١/.test(r2)
  greetsName    ? pass('Greets customer as أحمد') : fail('Name not acknowledged', r2)
  continuesFlow ? pass('Continues qualifying flow (asks month/group/level)') : fail('Did not continue qualifying flow', r2)
  noHandoff2    ? pass('No handoff on name-only message') : fail('HANDOFF TRIGGERED ON NAME — BUG C still present', r2)

  // MSG 3: Explicit booking intent — handoff SHOULD fire WITH phone number
  console.log('\n=== MSG 3: "عايز أحجز" (explicit booking intent) ===')
  const r3 = await send(P, 'عايز أحجز')
  console.log('  Reply:', r3)
  const hasHandoff3 = /هحول|زميلي المختص|هيتواصل/.test(r3)
  const hasPhone3   = /٠١[0-9٠-٩]{9}|01[0-9]{9}/.test(r3)
  hasHandoff3 ? pass('Handoff fires on explicit booking') : fail('Handoff did NOT fire on explicit booking', r3)
  hasPhone3   ? pass('Phone number included (first handoff)') : fail('Phone number missing from first handoff', r3)

  // MSG 4: Same explicit booking again — should give short ack WITHOUT phone number
  console.log('\n=== MSG 4: "عايز أحجز" again (repeat) ===')
  const r4 = await send(P, 'عايز أحجز')
  console.log('  Reply:', r4)
  const hasAck4     = /زميلنا هيتواصل|في انتظار|هيتابع/.test(r4)
  const noPhone4    = !/٠١[0-9٠-٩]{9}|01[0-9]{9}/.test(r4)
  hasAck4  ? pass('Short acknowledgment on repeat booking') : fail('No acknowledgment on repeat', r4)
  noPhone4 ? pass('Phone NOT repeated (handoffMessageSent working)') : fail('Phone number REPEATED — BUG D still present', r4)

  console.log('\n=== Done ===')
  await pool.end()
}
run().catch(e => { console.error(e.message); pool.end() })
