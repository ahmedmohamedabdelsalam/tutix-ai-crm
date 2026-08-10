/**
 * GATE — BSUID IDENTITY CAPTURE  (silent-data-loss class)
 *
 * Meta's usernames rollout replaces the phone number as the identifier. Once a user
 * adopts a username, `from` and `wa_id` are omitted and identity arrives only as
 * contacts[0].user_id, formatted "<CC>.<alnum>".
 *
 * Two failures this holds the line on, both of which are invisible in production:
 *
 *   1. THE SILENT DROP. Until 2026-08-07 a message without `from` was discarded
 *      after a 200 had already been sent — no log, no row, no alarm, no Meta
 *      retry. The customer vanished permanently and nobody could have known.
 *      Worse here than elsewhere: this number is Cloud-API only, so there is no
 *      WhatsApp Business app inbox anyone could fall back to.
 *
 *   2. THE LOST LINK. During the transition Meta sends BOTH identifiers. That
 *      overlap is the only window in which an existing phone-keyed conversation
 *      can be tied to the same person's BSUID. Miss it and a returning customer
 *      looks brand-new, with their history orphaned permanently — nothing
 *      afterwards ever reconnects them. A regression here would cost history that
 *      cannot be reconstructed, which is why it is worth a gate rather than a
 *      one-off check.
 *
 * Drives the REAL /webhook route, not the helpers, so it fails if capture breaks
 * anywhere between HTTP and the database.
 *
 * SAFETY: test phone only; creates and removes its own rows; touches no other
 * conversation. Sends nothing to WhatsApp — the webhook path only replies via the
 * company's token, and the test phone is not a real customer.
 *
 *   node test/gate/bsuid-suite.js
 */
'use strict'
const http = require('http')
const { spawn } = require('child_process')
const { Pool } = require('pg')
require('dotenv').config()

const PORT  = Number(process.env.GATE_PORT || 3556)
const PHONE = '201091656041'
const CO    = process.env.DEFAULT_COMPANY_ID
if (!CO) { console.error('FATAL: DEFAULT_COMPANY_ID not set'); process.exit(1) }

const BSUID       = 'EG.13491208655302741918'
const OTHER_BSUID = 'EG.99887766554433221100'
const pool  = new Pool({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL })
const delay = ms => new Promise(r => setTimeout(r, ms))
const logs  = []

function post(body) {
  const d = JSON.stringify(body)
  return new Promise((res, rej) => {
    const q = http.request({
      hostname: 'localhost', port: PORT, path: '/webhook', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) },
    }, r2 => { let s = ''; r2.on('data', c => s += c); r2.on('end', () => res(r2.statusCode)) })
    q.on('error', rej); q.setTimeout(40000, () => { q.destroy(); rej(new Error('timeout')) })
    q.write(d); q.end()
  })
}

const envelope = value => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ value }] }] })
/** A normal inbound text message, optionally carrying extra contact fields. */
const textMsg = (id, contactExtra = {}, from = PHONE) => envelope({
  metadata: { phone_number_id: process.env.GATE_PHONE_ID || '1191029790754985' },
  contacts: [{ profile: { name: 'Gate' }, ...(from ? { wa_id: from } : {}), ...contactExtra }],
  messages: [{ id, ...(from ? { from } : {}), type: 'text', timestamp: '1780000000', text: { body: 'اهلا' } }],
})

;(async () => {
  const c = await pool.connect()
  let pass = 0, fail = 0, srv = null
  const t = (ok, label, detail) => {
    if (ok) { console.log(`  ✅ ${label}`); pass++ }
    else { console.log(`  ❌ ${label}${detail ? `\n     ${detail}` : ''}`); fail++ }
  }

  const nuke = async () => {
    const { rows } = await c.query('SELECT id FROM "Conversation" WHERE phone=$1 AND "companyId"=$2', [PHONE, CO])
    for (const { id } of rows) {
      await c.query('DELETE FROM "Message" WHERE "conversationId"=$1', [id])
      await c.query('DELETE FROM "Conversation" WHERE id=$1', [id])
    }
    await c.query('DELETE FROM "Lead" WHERE phone=$1 AND "companyId"=$2', [PHONE, CO])
  }
  const storedId = async () => (await c.query(
    'SELECT "waUserId" FROM "Conversation" WHERE phone=$1 AND "companyId"=$2 ORDER BY "createdAt" DESC LIMIT 1',
    [PHONE, CO])).rows[0]?.waUserId ?? null
  const convId = async () => (await c.query(
    'SELECT id FROM "Conversation" WHERE phone=$1 AND "companyId"=$2 ORDER BY "createdAt" DESC LIMIT 1',
    [PHONE, CO])).rows[0]?.id ?? null

  // The webhook path runs the full AI pipeline, so a turn takes several seconds.
  const settle = () => delay(9000)

  try {
    // The column must exist before anything else is meaningful.
    const col = (await c.query(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_name='Conversation' AND column_name='waUserId'`)).rows[0]
    if (!col) {
      console.error('FATAL: Conversation.waUserId does not exist — run `npx prisma db push` first')
      process.exit(1)
    }

    srv = spawn('node', ['dist/src/main.js'], {
      cwd: 'c:/Users/Computec/tutix-ai-crm', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'production', PORT: String(PORT) },
    })
    srv.stdout.on('data', d => logs.push(d.toString()))
    srv.stderr.on('data', d => logs.push(d.toString()))
    for (let i = 0; i < 45; i++) {
      await delay(1000)
      const up = await new Promise(r => {
        const q = http.request({ hostname: 'localhost', port: PORT, path: '/webhook/health' }, x => r(x.statusCode === 200))
        q.on('error', () => r(false)); q.end()
      })
      if (up) break
    }

    console.log(`schema: Conversation.waUserId present, nullable=${col.is_nullable}\n`)

    // ── A. the link — the thing that cannot be recovered if missed ───────────
    console.log('A. capture during the dual-identifier window')
    await nuke()
    await post(textMsg('wamid.GATE_A', { user_id: BSUID }))
    await settle()
    t(await storedId() === BSUID, 'BSUID stored on the phone-keyed conversation', `got ${await storedId()}`)
    t(logs.join('').includes('BSUID_LINKED'), 'BSUID_LINKED logged')

    // ── B. idempotent — no write churn on every subsequent message ───────────
    console.log('\nB. repeat messages from the same person')
    const before = logs.length
    await post(textMsg('wamid.GATE_B', { user_id: BSUID }))
    await settle()
    const since = logs.slice(before).join('')
    t(await storedId() === BSUID, 'still linked to the same BSUID')
    t(!since.includes('BSUID_LINKED'), 'does not re-link an already-linked row')
    t(!since.includes('BSUID_CONFLICT'), 'no false conflict on an unchanged id')

    // ── C. never overwrite — silently replacing identity merges two people ───
    console.log('\nC. a DIFFERENT id on an already-linked conversation')
    const b2 = logs.length
    await post(textMsg('wamid.GATE_C', { user_id: OTHER_BSUID }))
    await settle()
    t(await storedId() === BSUID, 'stored id is NOT overwritten', `got ${await storedId()}`)
    t(logs.slice(b2).join('').includes('BSUID_CONFLICT'), 'BSUID_CONFLICT logged instead of silently replacing')

    // ── D. validation — a bad value under a unique index is expensive ────────
    console.log('\nD. malformed identifiers are rejected')
    for (const bad of ['not-a-bsuid!!', 'EGX.123', '13491208655302741918', 'EG.', '']) {
      await nuke()
      await post(textMsg(`wamid.GATE_D_${Math.random().toString(36).slice(2, 8)}`, { user_id: bad }))
      await settle()
      t(await storedId() === null, `rejected: ${JSON.stringify(bad)}`, `stored ${await storedId()}`)
    }

    // ── E. today's normal traffic is untouched ───────────────────────────────
    console.log('\nE. no user_id present (all traffic today)')
    await nuke()
    await post(textMsg('wamid.GATE_E', {}))
    await settle()
    t(await convId() !== null, 'conversation still created normally')
    t(await storedId() === null, 'waUserId stays null — no behaviour change')

    // ── F. the silent drop must stay closed ──────────────────────────────────
    console.log('\nF. a message we cannot identify')
    await nuke()
    const b3 = logs.length
    const status = await post(envelope({
      metadata: { phone_number_id: process.env.GATE_PHONE_ID || '1191029790754985' },
      contacts: [{ profile: { name: 'Gate' }, user_id: BSUID }],
      messages: [{ id: 'wamid.GATE_F', type: 'text', timestamp: '1780000000', text: { body: 'سؤال سري' } }],
    }))
    await delay(1500)
    const out = logs.slice(b3).join('')
    const alarm = (out.match(/\[WEBHOOK_NO_IDENTITY\][^\n]*/) || [''])[0]
    t(status === 200, 'still returns 200 to Meta (never retried, never queued)')
    t(!!alarm, 'ALARMS — the silent drop is closed', out.slice(0, 200))
    t(alarm.includes('UNREACHABLE'), 'states the customer is unreachable')
    t(!alarm.includes('سؤال سري'), 'does not leak the message body')
    t(!alarm.includes('13491208655302741918'), 'does not leak the full BSUID')
    t(alarm.includes('user_id=present'), 'records that a BSUID WAS present — the diagnostic signal')

    // ── G. status webhooks stay silent (4 in 5 of all traffic) ───────────────
    console.log('\nG. status/delivery webhooks')
    const b4 = logs.length
    await post(envelope({
      metadata: { phone_number_id: process.env.GATE_PHONE_ID || '1191029790754985' },
      statuses: [{ id: 'wamid.GATE_G', status: 'delivered' }],
    }))
    await delay(1200)
    t(!logs.slice(b4).join('').includes('WEBHOOK_NO_IDENTITY'),
      'do NOT alarm — they would bury the real signal')
  } catch (e) {
    console.error(`\nFATAL: ${e.message}`)
    fail++
  } finally {
    await nuke().catch(() => {})
    if (srv) { srv.kill('SIGTERM'); await delay(700) }
    c.release(); await pool.end()
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`)
  if (fail > 0) console.log('Customers can be lost, or their history orphaned, without anyone noticing.')
  process.exit(fail === 0 ? 0 : 1)
})()
