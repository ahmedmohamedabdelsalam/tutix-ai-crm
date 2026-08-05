/**
 * WEBHOOK DEDUP SUITE — the wamid insert is the dedup claim
 *
 * Message.whatsappMsgId carries a unique index, and handleMessage now sets it when
 * inserting the inbound USER row. A redelivered Meta webhook therefore loses that
 * race atomically (P2002) and returns without calling the model or sending anything.
 *
 * Why not drive POST /webhook directly: the controller would call sendWhatsAppMessage
 * against a company with live credentials — a real WhatsApp message to a real number.
 * So the suite posts to /webhook/test with an explicit `wamid` instead.
 *
 * Why the duplicate carries DIFFERENT text: the service already has a DEDUP_GUARD that
 * blocks identical USER text within 8s. Reusing the text would make these tests pass
 * without the wamid claim doing anything. Different text disables that guard, leaving
 * the unique index as the only thing that can stop the second call.
 *
 * handleMessage has FOUR distinct USER-insert sites; a claim missing from any one of
 * them lets redeliveries through on that branch. D1 covers the full AI pipeline
 * (site 4) and D4 covers the handed-off branch (site 3).
 *
 * Safety: simulate=true (zero WhatsApp sends), test phone only.
 * Run: node test/gate/dedup-suite.js   (after npm run build)
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
let serverProc = null

function httpPost(urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = http.request({ hostname: 'localhost', port: PORT, path: urlPath, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'X-Internal-Token': TEST_TOKEN } },
      res => { let b = ''; res.on('data', d => b += d); res.on('end', () => { try { resolve(JSON.parse(b)) } catch { resolve(b) } }) })
    req.on('error', reject); req.setTimeout(45000, () => { req.destroy(); reject(new Error('timeout')) })
    req.write(data); req.end()
  })
}
function httpGet(p) {
  return new Promise((resolve, reject) => {
    const r = http.request({ hostname: 'localhost', port: PORT, path: p }, res => resolve(res.statusCode))
    r.on('error', reject); r.setTimeout(4000, () => { r.destroy(); reject(new Error('t')) }); r.end()
  })
}
async function startServer() {
  serverProc = spawn('node', ['dist/src/main.js'], {
    cwd: path.join(__dirname, '../..'),
    env: { ...process.env, NODE_ENV: 'production', TEST_ENDPOINT_TOKEN: TEST_TOKEN },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  serverProc.stdout.on('data', () => {}); serverProc.stderr.on('data', () => {})
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
async function counts() {
  const c = await pool.connect()
  try {
    const r = await c.query(`
      SELECT count(*) FILTER (WHERE m.role='USER')::int AS users,
             count(*) FILTER (WHERE m.role='ASSISTANT')::int AS assistants
        FROM "Message" m JOIN "Conversation" cv ON cv.id=m."conversationId"
       WHERE cv.phone=$1 AND cv."companyId"=$2`, [PHONE, COMPANY])
    return r.rows[0]
  } finally { c.release() }
}
async function rowsWithWamid(w) {
  const c = await pool.connect()
  try {
    return (await c.query(`SELECT count(*)::int AS n FROM "Message" WHERE "whatsappMsgId"=$1`, [w])).rows[0].n
  } finally { c.release() }
}
async function setConvStatus(status) {
  const c = await pool.connect()
  try { await c.query(`UPDATE "Conversation" SET status=$1::"ConvStatus" WHERE phone=$2 AND "companyId"=$3`, [status, PHONE, COMPANY]) }
  finally { c.release() }
}
const send = (message, wamid) => httpPost('/webhook/test', { phone: PHONE, message, simulate: true, ...(wamid && { wamid }) })
const nReplies = r => (r?.replies || (r?.reply ? [r.reply] : [])).length

const SCENARIOS = [
  {
    id: 'D1',
    name: 'same wamid twice (full AI pipeline, site 4) → one row, one reply',
    async run() {
      await nuke()
      const w = 'wamid.dedup_' + Date.now()
      const r1 = await send('عايز اعرف عن العمرة', w)
      const after1 = await counts()
      const r2 = await send('سؤال تاني مختلف تماما', w)   // different text: DEDUP_GUARD cannot fire
      const after2 = await counts()

      const rows = await rowsWithWamid(w)
      const notes = []
      if (rows !== 1) notes.push(`FAIL: ${rows} rows carry the wamid (expected 1)`)
      if (after2.users !== after1.users) notes.push(`FAIL: USER rows grew ${after1.users}→${after2.users}`)
      if (after2.assistants !== after1.assistants) notes.push(`FAIL: ASSISTANT rows grew ${after1.assistants}→${after2.assistants} (a reply was generated for a duplicate)`)
      if (nReplies(r1) === 0) notes.push('FAIL: first delivery produced no reply')
      if (nReplies(r2) !== 0) notes.push(`FAIL: duplicate produced ${nReplies(r2)} replies`)
      return { pass: notes.length === 0, note: notes.join(' | ') || `1 row, first replied (${nReplies(r1)}), duplicate silent` }
    },
  },
  {
    id: 'D2',
    name: 'control: two DIFFERENT wamids both process normally',
    async run() {
      await nuke()
      const a = 'wamid.ctrl_a_' + Date.now(), b = 'wamid.ctrl_b_' + Date.now()
      await send('عايز اعرف عن العمرة', a)
      const after1 = await counts()
      await send('وكمان عايز اعرف عن الحج', b)
      const after2 = await counts()
      const ok = after2.users === after1.users + 1
      return { pass: ok, note: ok ? `USER rows ${after1.users}→${after2.users} — distinct wamids not blocked`
                                  : `FAIL: second message dropped (${after1.users}→${after2.users})` }
    },
  },
  {
    id: 'D3',
    name: 'no wamid supplied (legacy path) still processes both messages',
    async run() {
      await nuke()
      await send('عايز اعرف عن العمرة')
      const after1 = await counts()
      await send('سؤال مختلف خالص')
      const after2 = await counts()
      const ok = after2.users === after1.users + 1
      return { pass: ok, note: ok ? 'unstamped messages unaffected by the constraint'
                                  : `FAIL: ${after1.users}→${after2.users}` }
    },
  },
  {
    id: 'D4',
    name: 'same wamid twice on the HANDED-OFF branch (site 3) → one row',
    async run() {
      await nuke()
      await send('عايز اعرف عن العمرة')          // create the conversation
      await setConvStatus('NEEDS_HUMAN')          // force the handed-off insert site
      const w = 'wamid.handoff_' + Date.now()
      // simulate=false is not available here, so this exercises the same claim helper
      // through the pipeline that runs when the conversation is no longer AI_HANDLING.
      await send('رسالة بعد التحويل', w)
      const after1 = await counts()
      await send('رسالة تانية مختلفة', w)
      const after2 = await counts()
      const rows = await rowsWithWamid(w)
      const notes = []
      if (rows !== 1) notes.push(`FAIL: ${rows} rows carry the wamid`)
      if (after2.users !== after1.users) notes.push(`FAIL: USER rows grew ${after1.users}→${after2.users}`)
      return { pass: notes.length === 0, note: notes.join(' | ') || 'duplicate blocked on the non-AI branch too' }
    },
  },
  {
    id: 'D5',
    name: 'DB truly holds one row — unique index is the arbiter',
    async run() {
      const c = await pool.connect()
      try {
        const dup = (await c.query(`
          SELECT count(*)::int AS n FROM (
            SELECT "whatsappMsgId" FROM "Message" WHERE "whatsappMsgId" IS NOT NULL
             GROUP BY 1 HAVING count(*) > 1) x`)).rows[0].n
        return { pass: dup === 0, note: dup === 0 ? 'zero duplicate wamids table-wide' : `FAIL: ${dup} duplicated wamids` }
      } finally { c.release() }
    },
  },
]

;(async () => {
  console.log('WEBHOOK DEDUP SUITE\n')
  if (!await startServer()) { console.error('server failed to start'); process.exit(1) }
  const results = []
  try {
    for (const s of SCENARIOS) {
      process.stdout.write(`${s.id} ${s.name} ... `)
      let r; try { r = await s.run() } catch (e) { r = { pass: false, note: `ERROR: ${e.message}` } }
      results.push({ ...s, ...r })
      console.log(r.pass ? `PASS — ${r.note}` : `FAIL — ${r.note}`)
    }
  } finally {
    stopServer(); try { await nuke() } catch {} ; await pool.end()
  }
  const passed = results.filter(r => r.pass).length
  console.log('\n' + '='.repeat(70))
  results.forEach(r => console.log(`${r.pass ? '✅' : '❌'} ${r.id}: ${r.name}`))
  console.log(`\nTOTAL: ${passed}/${results.length}`)
  console.log(passed === results.length ? '✅ DEDUP SUITE PASS' : '❌ FAILURES PRESENT')
  process.exit(passed === results.length ? 0 : 1)
})()
