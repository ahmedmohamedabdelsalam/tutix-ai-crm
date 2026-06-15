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
function fail(msg, got) { console.log('  ✗ FAIL:', msg); if (got) console.log('       got:', got.substring(0, 200)) }

async function run() {
  const P = '201000009001'
  console.log('\n=== Clearing ===')
  await clearPhone(P)

  console.log('\n=== Step 1: Greeting ===')
  const r1 = await send(P, 'السلام عليكم')
  console.log('  Reply:', r1)
  const greetingHasCompany = /إسكندرية الدولية|اسكندرية الدولية/.test(r1)
  const greetingAsksName = /تشرفنا|اسم/.test(r1)
  greetingHasCompany ? pass('Greeting includes company name') : fail('Company name missing', r1)
  greetingAsksName   ? pass('Greeting asks for name') : fail('Name not asked', r1)

  console.log('\n=== Step 2: Customer sends name "محمود" ===')
  const r2 = await send(P, 'محمود')
  console.log('  Reply:', r2)

  const hasBad  = /بيخدمك إيه/.test(r2)
  const hasGood = /إزاي أقدر أساعدك|إيه اللي تحب|تحب أعرفك/.test(r2)
  const hasName = /محمود/.test(r2)
  const hasNour = /نورتنا/.test(r2)

  !hasBad  ? pass('No "بيخدمك إيه" in reply') : fail('"بيخدمك إيه" still present', r2)
  hasGood  ? pass('Warm alternative present (إزاي أقدر أساعدك / إيه اللي تحب / تحب أعرفك)') : fail('No warm alternative found', r2)
  hasName  ? pass('Customer name "محمود" used in reply') : fail('Name not in reply', r2)
  hasNour  ? pass('"نورتنا" warm welcome present') : fail('"نورتنا" missing', r2)

  console.log('\n=== Done ===')
  await pool.end()
}
run().catch(e => { console.error(e.message); pool.end() })
