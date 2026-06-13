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
function fail(msg, got) { console.log('  ✗ FAIL:', msg); if (got) console.log('       got:', got.substring(0, 500)) }

async function run() {
  const P = '201000005001'

  console.log('\n=== Clearing ===')
  await clearPhone(P)

  // ── Scenario 1: "عايز عمرة يوليو ٧ أيام، احنا ٣ أفراد" ─────────────────
  console.log('\n=== Scenario 1: عمرة يوليو ٧ أيام + ٣ أفراد في نفس الرسالة ===')
  await send(P, 'السلام عليكم')
  await send(P, 'خالد')
  const r1 = await send(P, 'عايز عمرة يوليو ٧ أيام احنا ٣ أفراد')
  console.log('  Reply:\n' + r1 + '\n')

  // 3 room-type per-person prices
  const hasQuad   = /رباعي/.test(r1)
  const hasTriple = /ثلاثي/.test(r1)
  const hasDouble = /ثنائي/.test(r1)

  // per-hotel breakfast labels (must mention مكة AND المدينة each with شامل or بدون)
  const meccaBreakfast   = /صفو[هة].*شامل|صفو[هة].*إفطار|شامل.*الإفطار.*\+|مكة.*شامل|مكة.*إفطار|\(شامل الإفطار\)|\(بدون إفطار\)/i.test(r1)
  const separateBreakfast = /مكة.*إفطار|مكة.*شامل|مكة.*بدون|شامل.*بدون|إفطار.*مكة|إفطار.*المدينة|شامل الإفطار.*بدون إفطار|بدون إفطار.*شامل|شامل\).*بدون\)|بدون\).*شامل\)/i.test(r1)

  // All 3 totals for 3 persons
  const totalQuad   = /إجمالي.*رباعي|رباعي.*إجمالي|إجمالي.*١٦٠|١٦٠.*إجمالي/.test(r1)
  const totalTriple = /إجمالي.*ثلاثي|ثلاثي.*إجمالي|إجمالي.*١٧١|١٧١.*إجمالي/.test(r1)
  const totalDouble = /إجمالي.*ثنائي|ثنائي.*إجمالي|إجمالي.*١٨٨|١٨٨.*إجمالي/.test(r1)

  hasQuad   ? pass('Shows رباعي per-person price') : fail('Missing رباعي', r1)
  hasTriple ? pass('Shows ثلاثي per-person price') : fail('Missing ثلاثي', r1)
  hasDouble ? pass('Shows ثنائي per-person price') : fail('Missing ثنائي', r1)
  separateBreakfast
    ? pass('Breakfast specified per hotel (مكة / المدينة labeled separately)')
    : fail('Breakfast not labeled per hotel — must say which hotel has breakfast', r1)
  totalQuad   ? pass('Shows total for 3×رباعي') : fail('Missing total for 3×رباعي', r1)
  totalTriple ? pass('Shows total for 3×ثلاثي') : fail('Missing total for 3×ثلاثي', r1)
  totalDouble ? pass('Shows total for 3×ثنائي') : fail('Missing total for 3×ثنائي', r1)

  // ── Scenario 2: same conversation, "وانا واحد بس، السعر كام؟" ────────────
  console.log('\n=== Scenario 2: follow-up "وانا واحد بس، السعر كام؟" → still show all 3 room types ===')
  const r2 = await send(P, 'وانا واحد بس السعر كام')
  console.log('  Reply:\n' + r2 + '\n')

  const r2Quad   = /رباعي/.test(r2)
  const r2Triple = /ثلاثي/.test(r2)
  const r2Double = /ثنائي/.test(r2)

  r2Quad   ? pass('Still shows رباعي for single person') : fail('Missing رباعي for single person — must always show all 3', r2)
  r2Triple ? pass('Still shows ثلاثي for single person') : fail('Missing ثلاثي for single person', r2)
  r2Double ? pass('Still shows ثنائي for single person') : fail('Missing ثنائي for single person', r2)

  console.log('\n=== Done ===')
  await pool.end()
}
run().catch(e => { console.error(e.message); pool.end() })
