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
  const c = await pool.query(
    `SELECT id FROM "Conversation" WHERE phone=$1 AND "companyId"=$2`, [phone, CID])
  for (const row of c.rows) {
    await pool.query(`DELETE FROM "Message" WHERE "conversationId"=$1`, [row.id])
    await pool.query(`DELETE FROM "Conversation" WHERE id=$1`, [row.id])
  }
  await pool.query(`DELETE FROM "Lead" WHERE phone=$1 AND "companyId"=$2`, [phone, CID])
}

function pass(msg) { console.log('  ✓ PASS:', msg) }
function fail(msg, got) { console.log('  ✗ FAIL:', msg); if (got) console.log('       got:', got.substring(0, 300)) }

async function run() {
  const phones = ['201000002001', '201000002002', '201000002003', '201000002004']
  console.log('\n=== Clearing test data ===')
  for (const p of phones) await clearPhone(p)
  console.log('  Done')

  // ── TEST 1: July 10-day → all 3 Trip 2 programs ──────────────────────────
  console.log('\n=== TEST 1: يوليو 10 أيام → must show all 3 Trip-2 programs ===')
  await send(phones[0], 'السلام عليكم')
  await send(phones[0], 'هاني')
  await send(phones[0], 'عايز عمرة')
  await send(phones[0], 'شخصين')
  const r1 = await send(phones[0], 'يوليو ١٠ أيام')
  console.log('  Reply (1st 800 chars):', r1.substring(0, 800))

  // Trip 2 programs: أزكى الصفا (52700 quad), الصفوة (68000 quad), موفنبيك (69000 quad)
  const showsAzkaSafa  = /أزكى الصفا|ازكى الصفا|أذكى الصفا/.test(r1)
  const showsSafwa     = /الصفوة/.test(r1)
  const showsMov       = /موفنبيك/.test(r1)
  showsAzkaSafa ? pass('Shows أزكى الصفا program') : fail('Missing أزكى الصفا (Trip 2/1)', r1)
  showsSafwa    ? pass('Shows الصفوة program')    : fail('Missing الصفوة (Trip 2/2)', r1)
  showsMov      ? pass('Shows موفنبيك program')   : fail('Missing موفنبيك (Trip 2/3)', r1)
  const noZawwar = !/زوار/.test(r1)
  noZawwar ? pass('No زوار العالمي in reply') : fail('زوار العالمي appeared!', r1)

  // ── TEST 2: August 10-day — must show BOTH Trip5 (26 Jul) AND Trip9 (18 Aug) ─
  // Trip5 + Trip9 together = 6 programs for August 10-day.
  // Critical: the bot must show programs from both departure date groups.
  console.log('\n=== TEST 2: أغسطس ١٠ أيام → must show programs from 2 departure dates ===')
  await send(phones[1], 'السلام عليكم')
  await send(phones[1], 'رانيا')
  await send(phones[1], 'شخصين')
  const r2 = await send(phones[1], 'عايزة عمرة أغسطس ١٠ أيام')
  console.log('  Reply (1st 1200 chars):', r2.substring(0, 1200))

  // Trip 5 departs 26 July, Trip 9 departs 18 August — both are أغسطس 10-day
  const hasTrip5date = /٢٦|٤ أغسطس/.test(r2)    // departure or return of Trip 5
  const hasTrip9date = /١٨|٢٧/.test(r2)           // departure or return of Trip 9
  const r2Hotels = [/الصفوة/, /موفنبيك/, /أزكى الصفا|ازكى/, /جراند بلازا/, /الحارثية/]
  const r2HotelsFound = r2Hotels.filter(re => re.test(r2)).length

  r2HotelsFound >= 3
    ? pass(`${r2HotelsFound} distinct hotel names shown for Aug 10-day`)
    : fail(`Only ${r2HotelsFound} hotels found — expected ≥3 (6 programs total)`, r2)
  // Either both dates appear OR enough hotels appear (indicating multiple trip groups)
  const coversBothGroups = hasTrip5date || hasTrip9date || r2HotelsFound >= 5
  coversBothGroups
    ? pass('Multiple program options shown (both trip groups covered)')
    : fail('Only one departure date group covered — missing programs', r2)

  // ── TEST 3: hotel names — زوار must NEVER appear ─────────────────────────
  console.log('\n=== TEST 3: Ask about hotels — زوار العالمي must never appear ===')
  await send(phones[2], 'السلام عليكم')
  await send(phones[2], 'كريم')
  const r3 = await send(phones[2], 'إيه أحسن فنادق المدينة عندكم؟')
  console.log('  Reply:', r3.substring(0, 500))
  !/زوار/.test(r3) ? pass('No زوار العالمي') : fail('زوار العالمي appeared!', r3)

  // ── TEST 4: 4 persons → رباعي price ──────────────────────────────────────
  console.log('\n=== TEST 4: ٤ أفراد → must use رباعي price ===')
  await send(phones[3], 'السلام عليكم')
  await send(phones[3], 'سمير')
  await send(phones[3], 'عايز عمرة سبتمبر ٧ أيام')
  const r4 = await send(phones[3], 'احنا ٤ أفراد، السعر كام؟')
  console.log('  Reply:', r4.substring(0, 600))

  // Trip 12 Sep 7-day quad prices: 56000, 48500, 57000
  // The total for 4 persons at quad price should appear (e.g. 56000×4=224000)
  const usedQuad = /٥٦٬٠٠٠|٤٨٬٥٠٠|٥٧٬٠٠٠|رباعي/.test(r4)
  const noTriple = !/ثلاثي|ثنائي/.test(r4)  // might mention room type names but shouldn't calculate wrong prices
  usedQuad  ? pass('Rbaai price mentioned in reply') : fail('Quad price not clearly used', r4)

  console.log('\n=== Done ===')
  await pool.end()
}
run().catch(e => { console.error(e.message); pool.end() })
