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
function fail(msg, got) { console.log('  ✗ FAIL:', msg); if (got) console.log('       got:', got.substring(0, 600)) }

async function run() {
  const P1 = '201000007001'
  const P2 = '201000007002'

  console.log('\n=== Clearing ===')
  await clearPhone(P1); await clearPhone(P2)

  // ── Scenario 1: full flow → month → should ask program type ──────────────
  console.log('\n=== Scenario 1: Full flow → after "يوليو" → expect program-type question ===')
  await send(P1, 'السلام عليكم')
  await send(P1, 'خالد')
  await send(P1, 'عمرة')
  const r1a = await send(P1, '٣ أفراد')
  console.log('  After "٣ أفراد":', r1a.substring(0, 150))

  const r1b = await send(P1, 'يوليو')
  console.log('\n  After "يوليو":\n' + r1b + '\n')

  const asksLevel = /مستوى|اقتصادي|نجوم/.test(r1b)
  const noDays = !/كام يوم|كام ليلة|عدد الأيام/.test(r1b)
  asksLevel ? pass('Asks about program level (مستوى)') : fail('Did not ask about program level', r1b)
  noDays    ? pass('Did NOT ask "كام يوم؟"') : fail('Still asking "كام يوم؟" — not fixed', r1b)

  // → choose اقتصادي متميز → should show all July اقتصادي متميز programs
  console.log('\n--- After "اقتصادي متميز" → expect ALL July اقتصادي متميز programs ---')
  const r1c = await send(P1, 'اقتصادي متميز')
  console.log('  Reply:\n' + r1c + '\n')

  // July اقتصادي متميز: Trip1P3 (إعمار المنار), Trip2P1 (أزكى الصفا), Trip3P3 (رمادا الفائزين), Trip4P1 (رمادا الفائزين again)
  const hasImar     = /إعمار المنار/.test(r1c)
  const hasAzka     = /أزكى الصفا/.test(r1c)
  const hasRamada   = /رمادا الفائزين/.test(r1c)
  const hasBooking  = /booking\.com|trip\.com|trivago\.com/.test(r1c)
  const stillNoDays = !/كام يوم/.test(r1c)

  hasImar    ? pass('Shows إعمار المنار program (Trip1P3)') : fail('Missing إعمار المنار (Trip1P3 اقتصادي متميز)', r1c)
  hasAzka    ? pass('Shows أزكى الصفا program (Trip2P1)') : fail('Missing أزكى الصفا (Trip2P1 اقتصادي متميز)', r1c)
  hasRamada  ? pass('Shows رمادا الفائزين program (Trip3P3/Trip4P1)') : fail('Missing رمادا الفائزين', r1c)
  hasBooking ? pass('Booking / review link included in presentation') : fail('No booking/review link found in presentation', r1c)
  stillNoDays ? pass('No "كام يوم؟" question in program presentation') : fail('"كام يوم؟" still appears', r1c)

  // ── Scenario 2: "خمس نجوم في أغسطس" directly → expect all August خمس نجوم ─
  console.log('\n=== Scenario 2: "عايز خمس نجوم في أغسطس" → expect all Aug خمس نجوم programs ===')
  await send(P2, 'السلام عليكم')
  await send(P2, 'سامي')
  await send(P2, 'عمرة')
  const r2 = await send(P2, 'عايز خمس نجوم في أغسطس')
  console.log('  Reply:\n' + r2 + '\n')

  // Aug خمس نجوم: Trip5P2 (الصفوة), Trip5P3 (موفنبيك), Trip7P1 (الصفوة), Trip7P2 (موفنبيك), Trip9P2 (الصفوة), Trip9P3 (موفنبيك)
  const hasSafwa  = /الصفوة/.test(r2)
  const hasMov    = /موفنبيك/.test(r2)
  const hasHarth  = /الحارثية/.test(r2)  // all 5-star Aug use الحارثية as medina hotel
  const r2Booking = /booking\.com/.test(r2)
  const r2NoDays  = !/كام يوم/.test(r2)

  hasSafwa  ? pass('Shows الصفوة (5-star Mecca hotel)') : fail('Missing الصفوة', r2)
  hasMov    ? pass('Shows موفنبيك (5-star Mecca hotel)') : fail('Missing موفنبيك', r2)
  hasHarth  ? pass('Shows الحارثية (5-star Medina hotel)') : fail('Missing الحارثية', r2)
  r2Booking ? pass('Booking link included') : fail('No booking link', r2)
  r2NoDays  ? pass('No "كام يوم؟" in reply') : fail('"كام يوم؟" still appears', r2)

  console.log('\n=== Done ===')
  await pool.end()
}
run().catch(e => { console.error(e.message); pool.end() })
