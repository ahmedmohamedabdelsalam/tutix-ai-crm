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
  { line: 570,  marker: 'HAJJ_CAT_REPLY',        q: '٣',                     setup: ['عايز اعرف عن برامج الحج'] },
  { line: 608,  marker: 'BLOCKED_CATEGORY',      q: 'عايز أعرف عن التأشيرة والفيزا' },
  { line: 651,  marker: 'INSTALLMENT_HANDOFF',   q: 'عندكم تقسيط؟' },
  { line: 673,  marker: 'HAJJ_DURATION_HANDLER', q: 'الحج كام يوم؟' },
  { line: 830,  marker: 'FULL_CATALOG_HANDLER',  q: 'عايز كل البرامج المتاحة' },
  // The *_ZERO_AI variants live on the first-message path, physically after the
  // non-first bypasses — hence the jump in line numbers here.
  { line: 849,  marker: 'HAJJ_CAT_Q_ZERO_AI',    q: 'عايز اعرف عن برامج الحج' },
  { line: 861,  marker: 'HAJJ_OV_ZERO_AI',       q: 'عايز برامج الحج الاقتصادية' },
  // One intent, several legitimate outcomes: with no trip chosen the flight block
  // correctly shows the overview and asks for a trip number (FLIGHT_SHOW_OV) rather
  // than answering. Any marker from the same block counts as "reached".
  { line: 944,  marker: ['FLIGHT_HANDLER', 'FLIGHT_SHOW_OV'], q: 'الطيران ايه في برامج سبتمبر؟' },
  { line: 973,  marker: 'NEAREST_TRIP_HANDLER',  q: 'أقرب رحلة عمرة امتى؟' },
  { line: 990,  marker: 'DEPARTURE_DATES_HANDLER', q: 'الرحلة بتقوم امتى؟' },
  { line: 1000, marker: 'ROOM_CAPACITY_HANDLER', q: 'الغرفة الرباعية كام شخص؟' },
  { line: 1019, marker: 'NIGHTS_HANDLER',        q: 'كام ليلة في المدينة؟' },
  { line: 1036, marker: 'HOTEL_DIST_HANDLER',    q: 'الصفوة كام متر من الحرم؟' },
  { line: 1052, marker: 'HOTEL_CONTENT_HANDLER', q: 'الفنادق ايه في برامج سبتمبر؟' },
  { line: 1071, marker: 'PRICE_PIVOT',           q: 'بكام برنامج العمرة؟' },
  { line: 1119, marker: 'GREETING_HANDLER',      q: 'السلام عليكم' },
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

// ── ORDERING INVARIANTS ──────────────────────────────────────────────────────
// Reachability catches a swallowed handler; these pin the invariant underneath it.
// Two DIFFERENT mechanisms protect handlers, so each is asserted the right way —
// a blanket line-order check would wrongly fail the second group.
//
//   A. SOURCE ORDER — the handler sits ABOVE the broader branch. Asserted statically
//      against whatsapp.service.ts, so drift fails without needing a server.
//   B. SPECIFICITY GUARD — the handler sits BELOW the bypasses on purpose and is
//      protected by hasSpecificHandlerIntent(). Line order is deliberately inverted
//      there, so it must be asserted BEHAVIOURALLY: a message combining the specific
//      intent with a month word has to reach the specific handler.
const SERVICE_SRC = require('fs').readFileSync(
  path.join(__dirname, '../../src/whatsapp/whatsapp.service.ts'), 'utf8').split('\n')

function markerLine(marker) {
  const i = SERVICE_SRC.findIndex(l => l.includes('`' + marker + ' →'))
  return i === -1 ? null : i + 1
}

// A. Pairs where POSITION is the protection. Each has actually broken.
const ORDER_PAIRS = [
  ['HAJJ_DURATION_HANDLER', 'HAJJ_CAT_Q_BYPASS',   'hajj duration must precede the hajj category bypass (broke 2026-08-05)'],
  ['HAJJ_DURATION_HANDLER', 'HAJJ_CAT_Q_ZERO_AI',  'same, on the first-message path — the placement that actually shipped wrong'],
  ['INSTALLMENT_HANDOFF',   'UMRAH_OV_BYPASS',     'installment must precede the umrah overview bypass'],
  ['INSTALLMENT_HANDOFF',   'DURATION_BYPASS',     'installment must precede the duration bypass'],
]

// B. Specific intent + a month word. The specific handler must win on BOTH paths —
// the guard existed only on the non-first path, so "first" is the case that broke.
const PRECEDENCE = [
  { q: 'الطيران ايه في برامج سبتمبر؟',              expect: ['FLIGHT_HANDLER', 'FLIGHT_SHOW_OV'] },
  { q: 'الصفوة كام متر من الحرم في برامج سبتمبر؟',   expect: ['HOTEL_DIST_HANDLER'] },
  { q: 'كام ليلة في المدينة في برامج سبتمبر؟',       expect: ['NIGHTS_HANDLER'] },
  { q: 'الغرفة الرباعية كام شخص في برامج سبتمبر؟',   expect: ['ROOM_CAPACITY_HANDLER'] },
  { q: 'عندكم تقسيط في برامج سبتمبر؟',              expect: ['INSTALLMENT_HANDOFF'] },
]

;(async () => {
  console.log('DISPATCH ORDER SUITE\n')

  // ── Section A: static source order (no server needed) ──────────────────────
  console.log('── A. source-order invariants ──')
  const orderResults = []
  for (const [before, after, why] of ORDER_PAIRS) {
    const lb = markerLine(before), la = markerLine(after)
    const ok = lb !== null && la !== null && lb < la
    orderResults.push({ label: `${before} < ${after}`, hit: ok, swallower: null })
    console.log(ok
      ? `✅ ${before} (${lb}) < ${after} (${la})`
      : `❌ ${before} (${lb ?? 'missing'}) must precede ${after} (${la ?? 'missing'}) — ${why}`)
  }

  // Registry line numbers are documentation; warn (do not fail) when they drift.
  const drift = REGISTRY.map(e => {
    const ms = Array.isArray(e.marker) ? e.marker : [e.marker]
    const actual = markerLine(ms[0])
    return actual && Math.abs(actual - e.line) > 3 ? `${ms[0]}: registry ${e.line} → actual ${actual}` : null
  }).filter(Boolean)
  if (drift.length) console.log(`\n⚠ registry line numbers drifted (documentation only):\n   ${drift.join('\n   ')}`)

  console.log('\n── B. reachability: each handler fires for its own question ──')
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
    // ── Section C: specific intent must beat a month/overview trigger ────────
    // Run on BOTH paths: the guard existed only on the non-first-message bypass,
    // so "first message" is the case that actually shipped broken.
    console.log('\n── C. precedence: specific intent beats the month/overview bypass ──')
    for (const p of PRECEDENCE) {
      for (const path of ['first message', 'mid-conversation']) {
        await nuke()
        if (path === 'mid-conversation') { await send('السلام عليكم'); await delay(300) }
        logBuf = []
        await send(p.q)
        await delay(200)
        const fired = markersFired().filter(m =>
          !['NEW_CONV', 'DEDUP_GUARD', 'WEBHOOK_DUP', 'TOKEN_USAGE', 'HANDOFF_LOG', 'SIG'].includes(m))
        const hit = p.expect.some(m => fired.includes(m))
        const swallower = hit ? null : (fired.find(f => !p.expect.includes(f)) ?? '(none — fell through to AI)')
        results.push({ label: `${p.expect[0]} beats overview [${path}]`, hit, swallower, line: '—' })
        console.log(hit
          ? `✅ ${p.expect[0]} wins [${path}]`
          : `❌ ${p.expect[0]} lost to ${swallower} [${path}]   [q: ${p.q}]`)
      }
    }
  } finally {
    stopServer(); try { await nuke() } catch {} ; await pool.end()
  }

  const all = [...orderResults, ...results]
  const passed = all.filter(r => r.hit).length
  console.log('\n' + '='.repeat(74))
  const failed = all.filter(r => !r.hit)
  if (failed.length) {
    console.log('FAILURES:')
    failed.forEach(r => console.log(`  ${r.label}${r.swallower ? ` → swallowed by ${r.swallower}` : ''}`))
  }
  console.log(`\nTOTAL: ${passed}/${all.length}`)
  console.log(passed === all.length ? '✅ DISPATCH ORDER SUITE PASS' : '❌ DISPATCH ORDER BROKEN')
  process.exit(passed === all.length ? 0 : 1)
})()
