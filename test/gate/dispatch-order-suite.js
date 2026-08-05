/**
 * DISPATCH ORDER SUITE — every handler must actually fire for its own question
 *
 * handleMessage is a long chain of early returns. A handler placed below a broader
 * branch is silently swallowed: the customer still gets *a* reply, tests still pass,
 * and the only symptom is the wrong answer. That has now happened three times, each
 * caught by manual audit rather than by a test:
 *
 *   • HAJJ_DURATION_HANDLER sat below HAJJ_CAT_Q_ZERO_AI → category question instead
 *     of the duration answer.
 *   • The nights handler read assistant catalog text as "context" and answered about
 *     the wrong program.
 *   • The hajj bridge pre-sorted the raw array and renumbered two surfaces.
 *
 * This suite makes that class of bug fail loudly. For each handler it sends the
 * canonical question and asserts THAT handler's log marker fired. When a different
 * marker fires, the failure names the swallower — which is the fact you need.
 *
 * REGISTRY BELOW IS THE DOCUMENTED DISPATCH ORDER. `line` is where the marker is
 * logged in whatsapp.service.ts. Keep it sorted; when you add a handler, add a row
 * here in the right position and the test will hold that position.
 *
 * Safety: simulate=true (zero WhatsApp sends), test phone only.
 * Run: node test/gate/dispatch-order-suite.js   (after npm run build)
 */
'use strict'
const http   = require('http')
const path   = require('path')
const { Pool }  = require('pg')
const { spawn } = require('child_process')
require('dotenv').config()

const PHONE   = '201091656041'
const COMPANY = process.env.DEFAULT_COMPANY_ID
const PORT    = parseInt(process.env.PORT || '3001', 10)
if (!COMPANY) { console.error('FATAL: DEFAULT_COMPANY_ID not set'); process.exit(1) }

const pool = new Pool({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL })
const TEST_TOKEN = process.env.TEST_ENDPOINT_TOKEN || require('crypto').randomBytes(24).toString('hex')
const delay = ms => new Promise(r => setTimeout(r, ms))
let serverProc = null, logBuf = []

// ── THE REGISTRY — dispatch order, canonical question per handler ─────────────
// setup: messages sent first to establish the state the handler needs.
const REGISTRY = [
  { line: 461,  marker: 'FD_CHUNK',              q: 'اعرضهم كلهم بالتفصيل', setup: ['عايز اعرف عن برامج الحج'] },
  { line: 518,  marker: 'OV_NUMBER',             q: '٢',                     setup: ['عايز برامج الحج الاقتصادية'] },
  { line: 568,  marker: 'HAJJ_CAT_REPLY',        q: '٣',                     setup: ['عايز اعرف عن برامج الحج'] },
  { line: 606,  marker: 'BLOCKED_CATEGORY',      q: 'عايز أعرف عن التأشيرة والفيزا' },
  { line: 649,  marker: 'INSTALLMENT_HANDOFF',   q: 'عندكم تقسيط؟' },
  { line: 671,  marker: 'HAJJ_DURATION_HANDLER', q: 'الحج كام يوم؟' },
  { line: 695,  marker: 'HAJJ_CAT_Q_ZERO_AI',    q: 'عايز اعرف عن برامج الحج' },
  { line: 707,  marker: 'HAJJ_OV_ZERO_AI',       q: 'عايز برامج الحج الاقتصادية' },
  { line: 837,  marker: 'FULL_CATALOG_HANDLER',  q: 'عايز كل البرامج المتاحة' },
  // One intent, several legitimate outcomes: with no trip chosen the flight block
  // correctly shows the overview and asks for a trip number (FLIGHT_SHOW_OV) rather
  // than answering. Any marker from the same block counts as "reached".
  { line: 949,  marker: ['FLIGHT_HANDLER', 'FLIGHT_SHOW_OV'], q: 'الطيران ايه في برامج سبتمبر؟' },
  { line: 978,  marker: 'NEAREST_TRIP_HANDLER',  q: 'أقرب رحلة عمرة امتى؟' },
  { line: 995,  marker: 'DEPARTURE_DATES_HANDLER', q: 'الرحلة بتقوم امتى؟' },
  { line: 1005, marker: 'ROOM_CAPACITY_HANDLER', q: 'الغرفة الرباعية كام شخص؟' },
  { line: 1024, marker: 'NIGHTS_HANDLER',        q: 'كام ليلة في المدينة؟' },
  { line: 1041, marker: 'HOTEL_DIST_HANDLER',    q: 'الصفوة كام متر من الحرم؟' },
  { line: 1057, marker: 'HOTEL_CONTENT_HANDLER', q: 'الفنادق ايه في برامج سبتمبر؟' },
  { line: 1076, marker: 'PRICE_PIVOT',           q: 'بكام برنامج العمرة؟' },
  { line: 1124, marker: 'GREETING_HANDLER',      q: 'السلام عليكم' },
]

function httpPost(p, body) {
  return new Promise((resolve, reject) => {
    const d = JSON.stringify(body)
    const r = http.request({ hostname: 'localhost', port: PORT, path: p, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d), 'X-Internal-Token': TEST_TOKEN } },
      res => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)) } catch { resolve(b) } }) })
    r.on('error', reject); r.setTimeout(60000, () => { r.destroy(); reject(new Error('timeout')) })
    r.write(d); r.end()
  })
}
const httpGet = p => new Promise((res, rej) => {
  const r = http.request({ hostname: 'localhost', port: PORT, path: p }, x => res(x.statusCode))
  r.on('error', rej); r.setTimeout(4000, () => { r.destroy(); rej(new Error('t')) }); r.end()
})

async function startServer() {
  serverProc = spawn('node', ['dist/src/main.js'], {
    cwd: path.join(__dirname, '../..'),
    env: { ...process.env, NODE_ENV: 'production', TEST_ENDPOINT_TOKEN: TEST_TOKEN },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  serverProc.stdout.on('data', d => logBuf.push(d.toString()))
  serverProc.stderr.on('data', d => logBuf.push(d.toString()))
  for (let i = 0; i < 40; i++) { await delay(1000); try { if (await httpGet('/webhook/health') === 200) return true } catch {} }
  return false
}
const stopServer = () => { if (serverProc) { serverProc.kill('SIGTERM'); serverProc = null } }

async function nuke() {
  const c = await pool.connect()
  try {
    const { rows } = await c.query('SELECT id FROM "Conversation" WHERE phone=$1 AND "companyId"=$2', [PHONE, COMPANY])
    for (const { id } of rows) {
      await c.query('DELETE FROM "Message" WHERE "conversationId"=$1', [id])
      await c.query('DELETE FROM "Conversation" WHERE id=$1', [id])
    }
    await c.query('DELETE FROM "Lead" WHERE phone=$1 AND "companyId"=$2', [PHONE, COMPANY])
  } finally { c.release() }
}
const send = m => httpPost('/webhook/test', { phone: PHONE, message: m, simulate: true })

/** Handler markers seen since the buffer was cleared, in order. */
function markersFired() {
  // STATE_RECOVERY logs as "STATE_RECOVERY overview →" — a lowercase word sits between
  // the marker and the arrow, so scan per line instead of requiring adjacency.
  const out = []
  for (const line of logBuf.join('').split('\n')) {
    if (!line.includes('→')) continue
    const m = line.match(/\b([A-Z][A-Z0-9_]{3,})\b/)
    if (m) out.push(m[1])
  }
  return out
}

;(async () => {
  console.log('DISPATCH ORDER SUITE — each handler must fire for its own question\n')
  if (!await startServer()) { console.error('server failed to start'); process.exit(1) }

  const results = []
  try {
    for (const entry of REGISTRY) {
      await nuke()
      for (const s of entry.setup ?? []) { await send(s); await delay(300) }
      logBuf = []                       // only capture the message under test
      await send(entry.q)
      await delay(200)

      const fired = markersFired().filter(m =>
        !['NEW_CONV', 'DEDUP_GUARD', 'WEBHOOK_DUP', 'TOKEN_USAGE', 'HANDOFF_LOG', 'SIG'].includes(m))
      const accepted = Array.isArray(entry.marker) ? entry.marker : [entry.marker]
      const hit = accepted.some(m => fired.includes(m))
      const swallower = hit ? null : (fired.find(f => !accepted.includes(f)) ?? '(none — fell through to AI)')
      const label = accepted.join(' | ')
      results.push({ ...entry, label, hit, swallower })
      console.log(hit
        ? `✅ ${label}`
        : `❌ ${label} — swallowed by ${swallower}   [q: ${entry.q}]`)
    }
  } finally {
    stopServer(); try { await nuke() } catch {} ; await pool.end()
  }

  const passed = results.filter(r => r.hit).length
  console.log('\n' + '='.repeat(74))
  const failed = results.filter(r => !r.hit)
  if (failed.length) {
    console.log('FAILURES — a handler is unreachable for its own canonical question:')
    failed.forEach(r => console.log(`  ${r.label} (line ${r.line}) → swallowed by ${r.swallower}`))
  }
  console.log(`\nTOTAL: ${passed}/${results.length}`)
  console.log(passed === results.length ? '✅ DISPATCH ORDER SUITE PASS' : '❌ DISPATCH ORDER BROKEN')
  process.exit(passed === results.length ? 0 : 1)
})()
