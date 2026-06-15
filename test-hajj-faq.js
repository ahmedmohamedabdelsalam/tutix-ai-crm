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

async function warmUp(phone, name) {
  await send(phone, 'السلام عليكم')
  await send(phone, name)
}

function pass(msg) { console.log('  ✓ PASS:', msg) }
function fail(msg, got) { console.log('  ✗ FAIL:', msg); if (got) console.log('       got:', got.substring(0, 400)) }

async function run() {
  const phones = ['201000011001', '201000011002', '201000011003', '201000011004']

  console.log('\n=== Clearing all phones ===')
  for (const p of phones) await clearPhone(p)

  // ── Scenario 1: "ليه أحج معاكم؟" ─────────────────────────────────────────
  console.log('\n=== Scenario 1: "ليه أحج معاكم؟" → detailed convincing answer ===')
  await warmUp(phones[0], 'محمد')
  const r1 = await send(phones[0], 'ليه أحج معاكم يعني إيه اللي يميزكم عن غيركم؟')
  console.log('  Reply:\n' + r1 + '\n')

  const hasTahseen  = /تحسين|١٤.*٢٠/.test(r1)
  const hasAziziyya = /عزيزية|يومين|يوم/.test(r1)
  const hasMadina   = /المدينة|مدينة/.test(r1)
  const hasSheikh   = /مشايخ|دعاة|المنجي|العانوس|شيخ/.test(r1)
  const noHandoff1  = !/هحول|زميلي المختص/.test(r1)

  hasTahseen  ? pass('Mentions 5-star Tahseen advantage') : fail('No Tahseen period mentioned', r1)
  hasAziziyya ? pass('Mentions Aziziyya short stay') : fail('No Aziziyya advantage mentioned', r1)
  hasMadina   ? pass('Mentions starting from Madinah') : fail('Madinah-first advantage missing', r1)
  hasSheikh   ? pass('Mentions scholars accompanying pilgrims') : fail('No scholars mentioned', r1)
  noHandoff1  ? pass('No premature handoff') : fail('Handoff fired unexpectedly', r1)

  // ── Scenario 2: Cheaper competitor ────────────────────────────────────────
  console.log('\n=== Scenario 2: "شفت برنامج بـ ٢٠٠ ألف" → asks for details, no price drop ===')
  await warmUp(phones[1], 'سامي')
  await send(phones[1], 'حج')
  const r2 = await send(phones[1], 'شفت برنامج اقتصادي تحسين برره بـ ٢٠٠ ألف')
  console.log('  Reply:\n' + r2 + '\n')

  const asksDetails  = /تفاصيل|نراجع|نقارن|تبعتلنا|تبعت/.test(r2)
  const noDiscount   = !/هنخفض|هنعمل خصم|بخصم|ممكن نعدل السعر/.test(r2)
  const noHandoff2   = !/هحول|زميلي المختص/.test(r2)

  asksDetails ? pass('Asks to compare details fairly') : fail('Did not ask for competitor details', r2)
  noDiscount  ? pass('Did not offer to lower price') : fail('Incorrectly offered a discount', r2)
  noHandoff2  ? pass('No premature handoff') : fail('Handoff fired unexpectedly', r2)

  // ── Scenario 3: Umrah discount request ────────────────────────────────────
  console.log('\n=== Scenario 3: "عايز خصم على العمرة" → politely decline ===')
  await warmUp(phones[2], 'هاني')
  await send(phones[2], 'عمرة')
  const r3 = await send(phones[2], 'عايز خصم على العمرة')
  console.log('  Reply:\n' + r3 + '\n')

  const declinesDiscount = /أسعار رسمية|مش بنعمل خصوم|السعر الرسمي|مفيش خصم|النهائية|خصومات/.test(r3)
  const noPromise        = !/هنعمل خصم|ممكن نعمل|هنشوف|هنحاول/.test(r3)
  const noHandoff3       = !/هحول|زميلي المختص/.test(r3)

  declinesDiscount ? pass('Politely declines Umrah discount') : fail('Did not decline discount properly', r3)
  noPromise        ? pass('No discount promise made') : fail('Made a discount promise incorrectly', r3)
  noHandoff3       ? pass('No premature handoff') : fail('Handoff fired unexpectedly', r3)

  // ── Scenario 4: Elderly parent can't walk ─────────────────────────────────
  console.log('\n=== Scenario 4: "والدي مش قادر يمشي" → GPS + companion recommendation ===')
  await warmUp(phones[3], 'كريم')
  await send(phones[3], 'حج')
  const r4 = await send(phones[3], 'والدي مش قادر يمشي كتير عنده ٧٥ سنة')
  console.log('  Reply:\n' + r4 + '\n')

  const hasGPS       = /GPS|جي بي إس|تتبع/.test(r4)
  const hasCompanion = /مرافق|أقارب|حد معاه|حد من الأسرة/.test(r4)
  const notDismissed = !/مشكلة بسيطة|مفيش مشكلة/.test(r4)
  const noHandoff4   = !/هحول|زميلي المختص/.test(r4)

  hasGPS       ? pass('Mentions GPS tracking') : fail('No GPS tracking mentioned', r4)
  hasCompanion ? pass('Recommends a companion/family member') : fail('No companion recommendation', r4)
  notDismissed ? pass('Concern not dismissed') : fail('Concern was dismissed', r4)
  noHandoff4   ? pass('No premature handoff') : fail('Handoff fired unexpectedly', r4)

  console.log('\n=== Done ===')
  await pool.end()
}
run().catch(e => { console.error(e.message); pool.end() })
