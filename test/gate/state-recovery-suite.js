/**
 * STATE RECOVERY SUITE — in-memory conversation state lost mid-conversation
 *
 * overviewMap / fullDetailsMap / categoryQuestionMap / noMatchMap live in process
 * memory. Every deploy wipes them. Before src/whatsapp/state-recovery.ts a customer
 * who replied "٣" after a deploy got NOTHING — a silent dead-end that only ever
 * reproduced in production.
 *
 * State loss is simulated the honest way: the server is genuinely RESTARTED between
 * two turns of the same conversation. No test-only endpoint, no reaching into the
 * process — exactly what a deploy does.
 *
 * Each scenario asserts the customer gets a USEFUL reply, never silence.
 * S5 is the regression guard for the opposite failure: a bare number that is NOT a
 * menu choice ("٤" = four people) must still fall through untouched.
 *
 * Safety: simulate=true (zero WhatsApp sends), test phone only.
 * Run: node test/gate/state-recovery-suite.js   (after npm run build)
 */
'use strict'
const http   = require('http')
const path   = require('path')
const { Pool }  = require('pg')
const { spawn } = require('child_process')
require('dotenv').config()

const PHONE   = '201091656041'
const COMPANY = process.env.DEFAULT_COMPANY_ID
const HOST    = 'localhost'
const PORT    = parseInt(process.env.PORT || '3001', 10)
if (!COMPANY) { console.error('FATAL: DEFAULT_COMPANY_ID not set'); process.exit(1) }

const pool = new Pool({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL })

// Same token convention as the other gate suites: env when set, else ephemeral,
// injected into the server this suite spawns. Never hardcoded.
const TEST_TOKEN = process.env.TEST_ENDPOINT_TOKEN || require('crypto').randomBytes(24).toString('hex')

let serverProc = null
const delay = ms => new Promise(r => setTimeout(r, ms))

function httpPost(urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = http.request({ hostname: HOST, port: PORT, path: urlPath, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'X-Internal-Token': TEST_TOKEN } },
      res => { let b = ''; res.on('data', d => b += d); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(b) }) } catch { resolve({ status: res.statusCode, body: b }) } }) })
    req.on('error', reject)
    req.setTimeout(45000, () => { req.destroy(); reject(new Error('timeout')) })
    req.write(data); req.end()
  })
}
function httpGet(urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: HOST, port: PORT, path: urlPath, method: 'GET' },
      res => { let b = ''; res.on('data', d => b += d); res.on('end', () => resolve({ status: res.statusCode })) })
    req.on('error', reject); req.setTimeout(4000, () => { req.destroy(); reject(new Error('t')) }); req.end()
  })
}

async function startServer() {
  serverProc = spawn('node', ['dist/src/main.js'], {
    cwd: path.join(__dirname, '../..'),
    env: { ...process.env, NODE_ENV: 'production', TEST_ENDPOINT_TOKEN: TEST_TOKEN },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  serverProc.stdout.on('data', () => {})
  serverProc.stderr.on('data', () => {})
  for (let i = 0; i < 40; i++) {
    await delay(1000)
    try { if ((await httpGet('/webhook/health')).status === 200) return true } catch {}
  }
  return false
}
function stopServer() {
  if (serverProc) { serverProc.kill('SIGTERM'); serverProc = null }
}
/** The whole point: a real restart, which wipes every in-memory Map. */
async function restartServer() {
  stopServer()
  await delay(1500)
  const ok = await startServer()
  if (!ok) throw new Error('server did not come back up after restart')
}

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

async function send(message) {
  const r = await httpPost('/webhook/test', { phone: PHONE, message, simulate: true })
  if (r.body?.error) throw new Error(r.body.error)
  const replies = r.body?.replies || (r.body?.reply ? [r.body.reply] : [])
  return replies.join('\n---\n')
}

const isSilent = r => !r || r.trim().length === 0
const looksLikeOverview = r => /⭐\s*[١٢٣٤٥٦٧٨٩]•/.test(r)
const looksLikeCategoryQ = r => /[١٢٣٤٥٦٧٨٩]•\s*\*(البرامج الاقتصادية|برامج خمس نجوم|أبراج كدانة)\*/.test(r)

const SCENARIOS = [
  {
    id: 'S1',
    name: 'overviewMap lost → bare number re-sends the overview',
    async run() {
      await nuke()
      const ov = await send('مواعيد العمره المتاحه كلها')
      if (!looksLikeOverview(ov)) return { pass: false, note: 'setup failed: no overview in turn 1' }
      await restartServer()
      const r = await send('٣')
      if (isSilent(r)) return { pass: false, note: 'SILENCE — the bug this suite exists for' }
      const recovered = looksLikeOverview(r)
      return { pass: recovered, note: recovered
        ? 'overview re-sent after state loss'
        : `no overview in recovery reply: ${r.slice(0, 90)}` }
    },
  },
  {
    id: 'S2',
    name: 'overviewMap lost → the re-sent list is usable (number works on retry)',
    async run() {
      await nuke()
      await send('مواعيد العمره المتاحه كلها')
      await restartServer()
      const rec = await send('٣')           // recovery: re-sends overview + restores state
      if (isSilent(rec)) return { pass: false, note: 'SILENCE on the recovery turn' }
      // A DIFFERENT number on the retry: repeating "٣" inside 8s trips the service
      // dedup guard (identical USER text), which would look like silence.
      const detail = await send('٢')
      if (isSilent(detail)) return { pass: false, note: 'SILENCE on retry — state not restored' }
      const looped = detail.includes('اتفضل البرامج تاني') || detail.includes('اتفضل الأقسام تاني')
      return { pass: !looped, note: looped
        ? 'looped: recovery fired again instead of resolving the number'
        : 'number resolved against the restored state — no loop' }
    },
  },
  {
    id: 'S3',
    name: 'categoryQuestionMap lost → category question re-sent',
    async run() {
      await nuke()
      const q = await send('عايز اعرف عن برامج الحج')
      if (!looksLikeCategoryQ(q)) return { pass: false, note: 'setup failed: no category question' }
      await restartServer()
      const r = await send('١')
      if (isSilent(r)) return { pass: false, note: 'SILENCE — dead-end after state loss' }
      const useful = looksLikeCategoryQ(r) || looksLikeOverview(r)
      return { pass: useful, note: useful ? 'category question (or programs) re-sent' : `unhelpful: ${r.slice(0, 90)}` }
    },
  },
  {
    id: 'S4',
    name: 'fullDetailsMap lost → "كمل" resumes instead of dead-ending',
    async run() {
      await nuke()
      await send('عايز اعرف عن برامج الحج')
      const chunk = await send('اعرضهم كلهم بالتفصيل')
      if (!/أكملك الباقي/.test(chunk)) return { pass: false, note: 'setup failed: no unfinished chunk' }
      await restartServer()
      const r = await send('كمل')
      if (isSilent(r)) return { pass: false, note: 'SILENCE — "كمل" dead-ended' }
      const resumed = /أكملك الباقي/.test(r) || /عرضتلك كل البرامج/.test(r)
      return { pass: resumed, note: resumed ? 'chunk delivery resumed from the start' : `no chunk in reply: ${r.slice(0, 90)}` }
    },
  },
  {
    id: 'S5',
    name: 'REGRESSION GUARD: bare number with no overview in history must NOT recover',
    async run() {
      await nuke()
      // Lead-capture context, no overview anywhere in the conversation.
      await send('السلام عليكم')
      await restartServer()
      const r = await send('٤')     // "four people", not a menu choice
      if (isSilent(r)) return { pass: false, note: 'SILENCE' }
      const wronglyRecovered = looksLikeOverview(r) || looksLikeCategoryQ(r)
      return { pass: !wronglyRecovered, note: wronglyRecovered
        ? 'REGRESSION: recovery fired on a number that was never a menu choice'
        : 'fell through normally, as before' }
    },
  },
  {
    id: 'S6',
    name: 'noMatchMap lost → no silence (counter resets, fails open)',
    async run() {
      await nuke()
      await send('نطنط بلبل زقزق')
      await restartServer()
      const r = await send('فرتك منتك زلابيا')
      return { pass: !isSilent(r), note: isSilent(r) ? 'SILENCE' : 'replied normally (handoff merely delayed)' }
    },
  },
]

;(async () => {
  console.log('STATE RECOVERY SUITE — simulating deploys mid-conversation\n')
  if (!await startServer()) { console.error('server failed to start'); process.exit(1) }
  const results = []
  try {
    for (const s of SCENARIOS) {
      process.stdout.write(`${s.id} ${s.name} ... `)
      let res
      try { res = await s.run() } catch (e) { res = { pass: false, note: `ERROR: ${e.message}` } }
      results.push({ ...s, ...res })
      console.log(res.pass ? `PASS — ${res.note}` : `FAIL — ${res.note}`)
    }
  } finally {
    stopServer()
    try { await nuke() } catch {}
    await pool.end()
  }
  const passed = results.filter(r => r.pass).length
  console.log('\n' + '='.repeat(70))
  results.forEach(r => console.log(`${r.pass ? '✅' : '❌'} ${r.id}: ${r.name}`))
  console.log(`\nTOTAL: ${passed}/${results.length}`)
  console.log(passed === results.length ? '✅ STATE RECOVERY SUITE PASS' : '❌ FAILURES PRESENT')
  process.exit(passed === results.length ? 0 : 1)
})()
