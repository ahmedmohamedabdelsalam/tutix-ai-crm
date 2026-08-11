/**
 * GATE — DELIVERY STATUS MUST ONLY EVER MOVE FORWARD  (step 5a)
 *
 * Three things have to hold, and the first is the one that will rot silently:
 *
 *   A. STATUS ADVANCES ONLY. Meta redelivers webhooks and does not guarantee order,
 *      so a stale `delivered` WILL arrive after a `read`. If it overwrites, the
 *      thread quietly downgrades a message the customer demonstrably read — and the
 *      rep, reading a double-tick instead of a blue one, chases someone who already
 *      replied in their head. Wrong is worse than absent.
 *
 *   B. A FAILURE CARRIES ITS REASON. `failed` is a customer who never received the
 *      message. Without the reason it is indistinguishable from "not delivered yet",
 *      which is the state everything looks like today.
 *
 *   C. AN ORPHAN LOGS AND RETURNS 200. A status for a wamid we never stamped must
 *      not throw: Meta retries an errored webhook, so an exception would amplify one
 *      bad status into a storm that also delays real inbound messages.
 *
 * SAFETY: builds its own conversation under the test phone with synthetic wamids,
 * asserts against it, deletes it in a finally block. Sends NOTHING to WhatsApp — it
 * posts status payloads inbound, which is the opposite direction.
 *
 *   npm run build && node test/gate/status-webhook-suite.js
 */
'use strict'
const http = require('http')
const path = require('path')
const crypto = require('crypto')
const { Pool } = require('pg')
const { spawn } = require('child_process')
require('dotenv').config()

const PHONE   = '201091656041'
const COMPANY = process.env.DEFAULT_COMPANY_ID
const PORT    = parseInt(process.env.PORT || '3001', 10)
if (!COMPANY) { console.error('FATAL: DEFAULT_COMPANY_ID not set'); process.exit(1) }

const pool = new Pool({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL })
const TEST_TOKEN = process.env.TEST_ENDPOINT_TOKEN || crypto.randomBytes(24).toString('hex')
const delay = ms => new Promise(r => setTimeout(r, ms))
let serverProc = null, logBuf = []

const S = require('../../dist/src/whatsapp/status-webhook')

const CONV = 'gate5aconv0001'
const M1 = 'gate5amsg0001', M2 = 'gate5amsg0002', M3 = 'gate5amsg0003'
const W1 = 'wamid.GATE5A0000000000000001'
const W2 = 'wamid.GATE5A0000000000000002'
const W3 = 'wamid.GATE5A0000000000000003'
const W_ORPHAN = 'wamid.GATE5AORPHANNEVERSTAMPED'

let pass = 0, fail = 0
const t = (ok, label, detail) => {
  if (ok) { console.log(`  ✅ ${label}`); pass++ }
  else { console.log(`  ❌ ${label}${detail ? `\n     ${detail}` : ''}`); fail++ }
}

function post(p, bodyObj, headers = {}) {
  return new Promise((resolve, reject) => {
    const d = JSON.stringify(bodyObj)
    const h = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d), ...headers }
    // Sign when a secret is configured; under warn mode the header is simply ignored.
    if (process.env.META_APP_SECRET) {
      h['x-hub-signature-256'] = 'sha256=' + crypto.createHmac('sha256', process.env.META_APP_SECRET).update(d).digest('hex')
    }
    const r = http.request({ hostname: 'localhost', port: PORT, path: p, method: 'POST', headers: h },
      res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b })) })
    r.on('error', reject); r.setTimeout(30000, () => { r.destroy(); reject(new Error('timeout')) })
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

const statusPayload = (waPhoneId, id, status, extra = {}) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'gate', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp',
    metadata: { display_phone_number: '0', phone_number_id: waPhoneId },
    statuses: [{ id, status, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: PHONE, ...extra }],
  } }] }],
})

/** The webhook answers before it processes, so poll for the effect. */
async function waitFor(c, msgId, predicate, ms = 8000) {
  const t0 = Date.now()
  let row = null
  while (Date.now() - t0 < ms) {
    row = (await c.query('SELECT status, "statusAt", "failureReason" FROM "Message" WHERE id=$1', [msgId])).rows[0]
    if (row && predicate(row)) return row
    await delay(250)
  }
  return row
}

;(async () => {
  const c = await pool.connect()
  const cleanup = async () => {
    await c.query('DELETE FROM "Message" WHERE "conversationId"=$1', [CONV]).catch(() => {})
    await c.query('DELETE FROM "Conversation" WHERE id=$1', [CONV]).catch(() => {})
  }

  try {
    // ══ 1. the ordering rule, as pure logic ═════════════════════════════════════
    console.log('1. the forward-only rule (dist/status-webhook)')
    t(S.advances(null, 'sent'), 'nothing → sent advances')
    t(S.advances('sent', 'delivered'), 'sent → delivered advances')
    t(S.advances('delivered', 'read'), 'delivered → read advances')
    t(!S.advances('read', 'delivered'), 'read → delivered is REFUSED (the out-of-order case)')
    t(!S.advances('read', 'sent'), 'read → sent is refused')
    t(!S.advances('delivered', 'sent'), 'delivered → sent is refused')
    t(!S.advances('read', 'read'), 'the same status twice changes nothing')
    t(S.advances('sent', 'failed'), 'sent → failed advances (failure is the newer truth)')
    t(!S.advances('read', 'failed'), 'read → failed is REFUSED (arrival is proof; a late failure cannot unsay it)')
    t(!S.advances('delivered', 'failed'), 'delivered → failed is refused')
    t(!S.advances('sent', 'banana'), 'an UNKNOWN status never overwrites')
    t(S.statusRank('banana') === 0, 'an unknown status ranks 0')
    t(!S.advances('sent', null) && !S.advances('sent', undefined), 'a missing status never overwrites')

    console.log('\n2. a failure explains itself')
    {
      const d = S.describeFailure({ errors: [{ code: 131047, title: 'Re-engagement message', error_data: { details: 'Message failed to send because more than 24 hours have passed' } }] })
      t(d.includes('131047'), `carries Meta's code — "${d.slice(0, 60)}…"`)
      t(d.includes('24 hours'), 'carries the human-readable detail')
      t(S.describeFailure({}).length > 0, 'never returns an empty reason, even with no error block')
    }

    // ══ 3. end to end against the real webhook ══════════════════════════════════
    console.log('\n3. end to end, through the real webhook')
    if (!await startServer()) { console.error('FATAL: server did not start'); fail++; throw new Error('no server') }

    const co = (await c.query('SELECT "waPhoneId" FROM "Company" WHERE id=$1', [COMPANY])).rows[0]
    if (!co?.waPhoneId) { console.error('FATAL: company has no waPhoneId'); fail++; throw new Error('no waPhoneId') }
    const PID = co.waPhoneId

    await cleanup()
    await c.query(
      `INSERT INTO "Conversation" (id,"companyId",phone,status,"agentMode","isTest","createdAt","updatedAt")
       VALUES ($1,$2,$3,'AI_HANDLING'::"ConvStatus",'HUMAN',true,now(),now())`, [CONV, COMPANY, PHONE])
    for (const [id, w] of [[M1, W1], [M2, W2], [M3, W3]]) {
      await c.query(
        `INSERT INTO "Message" (id,"conversationId",role,content,"whatsappMsgId","createdAt")
         VALUES ($1,$2,'ASSISTANT'::"MessageRole",$3,$4,now())`, [id, CONV, 'رسالة اختبار', w])
    }

    // A — forward, then a late 'delivered' that must NOT win
    console.log('\n   A. status advances, and never retreats')
    {
      let r = await post('/webhook', statusPayload(PID, W1, 'sent'))
      t(r.status === 200, `webhook returns 200 (got ${r.status})`)
      let row = await waitFor(c, M1, x => x.status === 'sent')
      t(row?.status === 'sent', `stored 'sent' (got ${row?.status})`)
      t(!!row?.statusAt, 'statusAt recorded')

      await post('/webhook', statusPayload(PID, W1, 'read'))
      row = await waitFor(c, M1, x => x.status === 'read')
      t(row?.status === 'read', `advanced to 'read' (got ${row?.status})`)

      // THE ASSERTION THIS SUITE EXISTS FOR
      r = await post('/webhook', statusPayload(PID, W1, 'delivered'))
      t(r.status === 200, 'a late, out-of-order status still returns 200')
      await delay(2000)
      row = (await c.query('SELECT status FROM "Message" WHERE id=$1', [M1])).rows[0]
      t(row?.status === 'read', `a LATE 'delivered' did NOT overwrite 'read' (still ${row?.status})`)
    }

    // B — failure carries its reason
    console.log('\n   B. a failed status records why')
    {
      await post('/webhook', statusPayload(PID, W2, 'failed', {
        errors: [{ code: 131047, title: 'Re-engagement message', error_data: { details: 'more than 24 hours have passed since the customer last replied' } }],
      }))
      const row = await waitFor(c, M2, x => x.status === 'failed')
      t(row?.status === 'failed', `stored 'failed' (got ${row?.status})`)
      t(!!row?.failureReason, 'failureReason is populated — not a silent failure')
      t((row?.failureReason || '').includes('131047'), `reason carries the code — "${(row?.failureReason || '').slice(0, 70)}"`)
    }

    // ...and a failure cannot unsay a read
    {
      await post('/webhook', statusPayload(PID, W3, 'read'))
      await waitFor(c, M3, x => x.status === 'read')
      await post('/webhook', statusPayload(PID, W3, 'failed', { errors: [{ code: 1, title: 'x' }] }))
      await delay(2000)
      const row = (await c.query('SELECT status, "failureReason" FROM "Message" WHERE id=$1', [M3])).rows[0]
      t(row?.status === 'read', `a late 'failed' did not overwrite 'read' (still ${row?.status})`)
      t(!row?.failureReason, 'and no failure reason was attached to a message that was read')
    }

    // C — the orphan: logs, does not throw, returns 200
    console.log('\n   C. an unmatched wamid is measured, not fatal')
    {
      logBuf.length = 0
      const r = await post('/webhook', statusPayload(PID, W_ORPHAN, 'delivered'))
      t(r.status === 200, `webhook returns 200 for an unknown wamid (got ${r.status})`)
      await delay(2000)
      const logs = logBuf.join('')
      t(logs.includes('[STATUS_ORPHAN]'), 'logged as [STATUS_ORPHAN]')
      t(logs.includes(W_ORPHAN), 'the orphan log names the wamid')
      t(logs.includes('delivered'), 'the orphan log names the status')
      t(await httpGet('/webhook/health') === 200, 'the server is still alive afterwards')
    }

    // A malformed batch must also not take the webhook down.
    {
      const r = await post('/webhook', { object: 'whatsapp_business_account', entry: [{ changes: [{ value: {
        metadata: { phone_number_id: PID }, statuses: [{ nonsense: true }, null, { id: W1 }],
      } }] }] })
      t(r.status === 200, 'a malformed status batch returns 200, not 500')
      await delay(1500)
      t(await httpGet('/webhook/health') === 200, 'and the server survives it')
    }
  } catch (e) {
    console.error(`\nFATAL: ${e.message}`)
    fail++
  } finally {
    await cleanup()
    stopServer(); c.release(); await pool.end()
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`)
  if (fail > 0) console.log('Delivery status can move backwards, lose its reason, or crash the webhook.')
  process.exit(fail === 0 ? 0 : 1)
})()
