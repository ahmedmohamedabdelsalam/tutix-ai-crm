/**
 * GATE — AN INBOUND IMAGE MUST PRODUCE A MESSAGE ROW
 *
 * This surface had NO test at all, and that is the only reason it stayed broken for
 * fourteen days.
 *
 * On 2026-08-10 the media branch began passing `{ orderBy: … }` into
 * findConversation's INCLUDE parameter. The parameter was typed `object`, so tsc was
 * satisfied; Prisma threw at runtime; the throw aborted the handler before any row
 * was written; and the outer catch logged one line nobody read. Every inbound image,
 * voice note and document was discarded — no row, no capture, no reply to the
 * customer — while inbound text carried on perfectly and hid the outage in the
 * aggregate.
 *
 * The assertion is deliberately the crudest possible one: a media webhook goes in, a
 * Message row comes out. Nothing subtler would have caught this, because everything
 * subtler happens after the point where it died.
 *
 * SAFETY: test phone only, conversation stamped isTest and agentMode=HUMAN so no
 * reply is sent to the handset. Cleans up in a finally block.
 *
 *   npm run build && node test/gate/inbound-media-suite.js
 */
'use strict'
const http = require('http')
const path = require('path')
const crypto = require('crypto')
const { Pool } = require('pg')
const { spawn } = require('child_process')
require('dotenv').config()

const PHONE = '201091656041'
const COMPANY = process.env.DEFAULT_COMPANY_ID
const PORT = parseInt(process.env.PORT || '3001', 10)
if (!COMPANY) { console.error('FATAL: DEFAULT_COMPANY_ID not set'); process.exit(1) }

const pool = new Pool({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL })
const TEST_TOKEN = process.env.TEST_ENDPOINT_TOKEN || crypto.randomBytes(24).toString('hex')
const delay = ms => new Promise(r => setTimeout(r, ms))
let serverProc = null, logBuf = []

const CONV = 'gatemediaconv01'
let pass = 0, fail = 0
const t = (ok, label, detail) => {
  if (ok) { console.log(`  ✅ ${label}`); pass++ }
  else { console.log(`  ❌ ${label}${detail ? `\n     ${detail}` : ''}`); fail++ }
}

function post(p, bodyObj) {
  return new Promise((resolve, reject) => {
    const d = JSON.stringify(bodyObj)
    const h = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) }
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

/** A real Meta inbound-media webhook, in the shape Meta actually posts. */
const mediaPayload = (waPhoneId, type, wamid) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'gate', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp',
    metadata: { display_phone_number: '0', phone_number_id: waPhoneId },
    contacts: [{ wa_id: PHONE, profile: { name: 'Gate Media Test' } }],
    messages: [{
      from: PHONE, id: wamid, timestamp: String(Math.floor(Date.now() / 1000)), type,
      [type]: type === 'document'
        ? { id: 'gate-fake-media-id', mime_type: 'application/pdf', filename: 'passport.pdf' }
        : { id: 'gate-fake-media-id', mime_type: type === 'image' ? 'image/jpeg' : 'audio/ogg' },
    }],
  } }] }],
})

async function rowsFor(c) {
  return (await c.query(
    `SELECT role, content, "mediaType" FROM "Message" WHERE "conversationId"=$1 ORDER BY "createdAt"`, [CONV])).rows
}

;(async () => {
  const c = await pool.connect()
  const cleanup = async () => {
    await c.query('DELETE FROM "Message" WHERE "conversationId"=$1', [CONV]).catch(() => {})
    await c.query('DELETE FROM "Conversation" WHERE id=$1', [CONV]).catch(() => {})
  }

  try {
    if (!await startServer()) { console.error('FATAL: server did not start'); fail++; throw new Error('no server') }
    const co = (await c.query('SELECT "waPhoneId" FROM "Company" WHERE id=$1', [COMPANY])).rows[0]
    if (!co?.waPhoneId) { console.error('FATAL: company has no waPhoneId'); fail++; throw new Error('no waPhoneId') }

    await cleanup()
    // agentMode=HUMAN so the branch does NOT send its fixed reply to the handset.
    await c.query(
      `INSERT INTO "Conversation" (id,"companyId",phone,status,"agentMode","isTest","createdAt","updatedAt")
       VALUES ($1,$2,$3,'AI_HANDLING'::"ConvStatus",'HUMAN',true,now(),now())`, [CONV, COMPANY, PHONE])

    // ── every media type takes the SAME code path — cover all three ──────────
    for (const type of ['image', 'audio', 'document']) {
      console.log(`\n${type}:`)
      logBuf.length = 0
      const before = (await rowsFor(c)).length
      const wamid = `wamid.GATEMEDIA${type.toUpperCase()}${Date.now()}`
      const r = await post('/webhook', mediaPayload(co.waPhoneId, type, wamid))
      t(r.status === 200, `webhook returns 200 (got ${r.status})`)

      // Poll: the webhook answers before it processes.
      let rows = []
      for (let i = 0; i < 24; i++) { await delay(250); rows = await rowsFor(c); if (rows.length > before) break }

      t(rows.length > before, `A MESSAGE ROW WAS CREATED (${before} → ${rows.length})`,
        'the row is the whole point — without it the customer is invisible to sales')
      const newest = rows[rows.length - 1]
      t(!!newest && newest.role === 'USER', `the row is inbound (role=${newest?.role})`)
      t(!!newest && !!newest.content, `it carries a placeholder ("${newest?.content}")`)

      // The failure mode that actually happened: a throw before any write.
      const logs = logBuf.join('')
      t(!/Webhook error/.test(logs), 'no "Webhook error" was thrown',
        (logs.match(/Webhook error[^\n]*/) || [''])[0])
      t(!/PrismaClientValidationError/.test(logs), 'no PrismaClientValidationError',
        'this is the exact error that discarded every inbound image for 14 days')
      t(/MEDIA MESSAGE/.test(logs), 'the media branch was actually REACHED')
    }
  } catch (e) {
    console.error(`\nFATAL: ${e.message}`)
    fail++
  } finally {
    await cleanup()
    stopServer(); c.release(); await pool.end()
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`)
  if (fail > 0) console.log('Inbound customer media is being discarded — sales never see it.')
  process.exit(fail === 0 ? 0 : 1)
})()
