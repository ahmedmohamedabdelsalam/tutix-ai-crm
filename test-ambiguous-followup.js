require('dotenv').config()
const { Pool } = require('pg')
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const CID = process.env.DEFAULT_COMPANY_ID

const BASE = 'http://localhost:3001'

async function send(phone, msg) {
  const r = await fetch(`${BASE}/webhook/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, message: msg }),
  })
  const j = await r.json()
  return j.reply ?? j.error ?? ''
}

async function getConv(phone) {
  const r = await pool.query(
    `SELECT "followUpStatus" FROM "Conversation"
     WHERE phone = $1 AND "companyId" = $2
     ORDER BY "updatedAt" DESC LIMIT 1`,
    [phone, CID],
  )
  return r.rows[0] ?? null
}

async function clearPhone(phone) {
  // Delete messages → conversations → leads for this test phone
  const convs = await pool.query(
    `SELECT id FROM "Conversation" WHERE phone = $1 AND "companyId" = $2`,
    [phone, CID],
  )
  for (const c of convs.rows) {
    await pool.query(`DELETE FROM "Message" WHERE "conversationId" = $1`, [c.id])
    await pool.query(`DELETE FROM "Conversation" WHERE id = $1`, [c.id])
  }
  await pool.query(`DELETE FROM "Lead" WHERE phone = $1 AND "companyId" = $2`, [phone, CID])
}

function pass(msg) { console.log('  ✓ PASS:', msg) }
function fail(msg, extra) { console.log('  ✗ FAIL:', msg); if (extra) console.log('       got:', extra) }

async function run() {
  const P1 = '201000000101'  // ambiguous message test
  const P2 = '201000000102'  // real هفكر flow

  console.log('\n=== Clearing test data ===')
  await clearPhone(P1)
  await clearPhone(P2)
  console.log('  Done')

  // ── TEST 1: mid-conv "ت" → must ask for clarification, NOT "خد وقتك" ─────
  // Build a real mid-conversation context first, then send the ambiguous "ت"
  console.log('\n=== TEST 1: Mid-conv single-char "ت" → clarification, NOT "خد وقتك" ===')
  await send(P1, 'السلام عليكم')
  await send(P1, 'خالد')
  await send(P1, 'عايز عمرة يوليو لشخصين')
  const r1 = await send(P1, 'ت')
  console.log('  Bot reply:', r1)

  const notAssumed = !/خد وقتك|هفكر|هأتواصل|حابب أتواصل/.test(r1)
  const askedClarif = /مفهمتش|توضح|بالتحديد|تقولي إيه|مش واضح/.test(r1)
  notAssumed
    ? pass('Did NOT assume "خد وقتك" / follow-up intent')
    : fail('"خد وقتك" or follow-up phrasing appeared — AI over-interpreted "ت"', r1)
  askedClarif
    ? pass('Asked for clarification ("مفهمتش" / "توضح")')
    : fail('No clarification question detected (check prompt rule)', r1)

  // ── TEST 2: After the clarification response, "تمام" must NOT schedule ──────
  console.log('\n=== TEST 2: "تمام" after clarification → followUpStatus = NONE ===')
  const r2 = await send(P1, 'تمام')
  console.log('  Bot reply:', r2)
  const conv1 = await getConv(P1)
  console.log('  followUpStatus:', conv1?.followUpStatus)
  conv1?.followUpStatus === 'NONE'
    ? pass('followUpStatus = NONE — no false follow-up scheduled')
    : fail('followUpStatus is NOT NONE', conv1?.followUpStatus)

  // ── TEST 3: Real "هفكر" flow — must still work ────────────────────────────
  console.log('\n=== TEST 3: Real هفكر flow → "تمام" must schedule follow-up ===')
  await send(P2, 'السلام عليكم')
  await send(P2, 'سامي')
  const r3a = await send(P2, 'خليني افكر وارد عليك')
  console.log('  Bot after هفكر:', r3a)

  const proposedFollowUp = /بكر[هة]/.test(r3a) && /أتواصل|هأتواصل/.test(r3a)
  proposedFollowUp
    ? pass('Bot proposed a follow-up with "بكرة" + contact verb')
    : fail('Bot did NOT propose follow-up for genuine "خليني افكر"', r3a)

  const r3b = await send(P2, 'تمام')
  console.log('  Bot after تمام:', r3b)
  const conv2 = await getConv(P2)
  console.log('  followUpStatus:', conv2?.followUpStatus)
  conv2?.followUpStatus === 'SCHEDULED'
    ? pass('followUpStatus = SCHEDULED — real follow-up correctly scheduled')
    : fail('Real هفكر flow broken — followUpStatus is NOT SCHEDULED', conv2?.followUpStatus)

  console.log('\n=== Done ===')
  await pool.end()
}

run().catch(e => { console.error(e.message); pool.end() })
