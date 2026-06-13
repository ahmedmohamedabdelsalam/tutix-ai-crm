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
function fail(msg, got) { console.log('  ✗ FAIL:', msg); if (got) console.log('       got:', got.substring(0, 400)) }

async function run() {
  const P1 = '201000003001'
  const P2 = '201000003002'

  console.log('\n=== Clearing ===')
  await clearPhone(P1); await clearPhone(P2)

  // ── TEST A: show all 3 prices + correct breakfast label (no person count given) ─
  console.log('\n=== TEST A: عمرة يوليو ٧ أيام بدون تحديد عدد → ثلاث أسعار + تحديد الإفطار ===')
  await send(P1, 'السلام عليكم')
  await send(P1, 'نور')
  const rA = await send(P1, 'عايزة عمرة يوليو ٧ أيام')
  console.log('  Reply:\n' + rA + '\n')

  const hasQuad   = /رباعي/.test(rA)
  const hasTriple = /ثلاثي/.test(rA)
  const hasDouble = /ثنائي/.test(rA)
  const breakfastClear = /إفطار بمكة|إفطار في مكة|إفطار بالمدينة|إفطار في المدينة|بدون إفطار|إفطار في الفندقين/.test(rA)

  hasQuad   ? pass('Shows رباعي price') : fail('Missing رباعي price', rA)
  hasTriple ? pass('Shows ثلاثي price') : fail('Missing ثلاثي price', rA)
  hasDouble ? pass('Shows ثنائي price') : fail('Missing ثنائي price', rA)
  breakfastClear
    ? pass('Breakfast location clearly specified (مكة/المدينة/بدون)')
    : fail('Breakfast location not specified — just "شاملة الإفطار" is ambiguous', rA)

  // ── TEST B: person count in initial query → still shows all 3 tiers + total ─
  console.log('\n=== TEST B: "عمرة لـ٣ أفراد" في نفس الرسالة → ثلاث تسكنات + إجمالي للثلاثي ===')
  await send(P2, 'السلام عليكم')
  await send(P2, 'طارق')
  const rB = await send(P2, 'عايز عمرة سبتمبر ١٠ أيام لـ ٣ أفراد')
  console.log('  Reply:\n' + rB + '\n')

  const bHasQuad   = /رباعي/.test(rB)
  const bHasTriple = /ثلاثي/.test(rB)
  const bHasDouble = /ثنائي/.test(rB)
  const bHasTotal  = /إجمالي|لـ ?٣|للثلاثة/.test(rB)
  bHasQuad   ? pass('Shows رباعي price') : fail('Missing رباعي', rB)
  bHasTriple ? pass('Shows ثلاثي price') : fail('Missing ثلاثي', rB)
  bHasDouble ? pass('Shows ثنائي price') : fail('Missing ثنائي', rB)
  bHasTotal  ? pass('Total for 3 persons shown') : fail('No total for 3 persons', rB)

  console.log('\n=== Done ===')
  await pool.end()
}
run().catch(e => { console.error(e.message); pool.end() })
