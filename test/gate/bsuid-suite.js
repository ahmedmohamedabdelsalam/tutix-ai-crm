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
/** Every BSUID this suite may write, so cleanup can be exhaustive. */
const SUITE_BSUIDS = [
  'EG.13491208655302741918', 'EG.99887766554433221100', 'EG.55554444333322221111',
  'EG.11112222333344445555', 'EG.66667777888899990000',
]
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
    // The suite deliberately creates unidentified-inbound rows; remove only its own.
    await c.query(`DELETE FROM "UnidentifiedInbound" WHERE wamid LIKE 'wamid.GATE_%'`)
    // Phase 3b processes BSUID-only messages into real conversations, so the suite
    // now creates phone-less rows too. Leaving them collides with
    // @@unique([companyId, waUserId]) on the next run and fails tests that have
    // nothing to do with the bug.
    for (const b of SUITE_BSUIDS) {
      await c.query(`DELETE FROM "Message" WHERE "conversationId" IN (SELECT id FROM "Conversation" WHERE "waUserId"=$1)`, [b])
      await c.query(`DELETE FROM "Conversation" WHERE "waUserId"=$1`, [b])
    }
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

    // THE LINKING WINDOW, tested for real: a conversation that already exists with
    // only a phone, then a later message carrying the BSUID. This is the case that
    // protects existing history — Phase 3b writes the id at creation, so a brand-new
    // conversation never exercises the backfill path at all.
    await nuke()
    await post(textMsg('wamid.GATE_A0', {}))                   // phone only
    await settle()
    t(await storedId() === null, 'existing conversation starts with no BSUID')
    const bLink = logs.length
    await post(textMsg('wamid.GATE_A1', { user_id: BSUID }))   // now Meta sends both
    await settle()
    t(await storedId() === BSUID, 'BACKFILLED onto the existing conversation — history preserved')
    t(logs.slice(bLink).join('').includes('BSUID_LINKED'), 'BSUID_LINKED logged for the backfill')

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
      contacts: [{ profile: { name: 'Gate' } }],
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
    t(alarm.includes('user_id=absent'), 'records that NO BSUID was present — nothing to recover from')

    // ── F2. the DURABLE record — the whole point of the table ────────────────
    // A log line dies with its container, and we deploy several times a day, so
    // the event we most need to count was the one we could least count. These
    // assertions are what make "how many customers did we lose last week" a
    // question with an answer.
    console.log('\nF2. lost inbound is persisted, not just logged')
    {
      const row = (await c.query(
        `SELECT * FROM "UnidentifiedInbound" WHERE wamid=$1`, ['wamid.GATE_F'])).rows[0]
      t(!!row, 'a row was written for the lost message')
      if (row) {
        t(row.waUserId === null, 'no BSUID to store for a no-identity payload', `got ${row.waUserId}`)
        t(row.reason === 'no_identity', `reason recorded (${row.reason})`)
        t(row.messageType === 'text', `message type recorded (${row.messageType})`)
        t(!!row.companyId, 'attributed to a company via phone_number_id — queryable per tenant')
        t(row.hasWaId === false, 'records that wa_id was absent')
        t(typeof row.messageKeys === 'string' && row.messageKeys.includes('text'),
          'payload shape recorded', row.messageKeys)
        // Shape only: the body and the profile name must never be persisted here.
        const blob = JSON.stringify(row)
        t(!blob.includes('سؤال سري'), 'does NOT persist the message body')
        t(!blob.includes('Gate'), 'does NOT persist the profile name')
      }
      // Meta redelivers webhooks; the partial unique index must absorb that.
      await post(envelope({
        metadata: { phone_number_id: process.env.GATE_PHONE_ID || '1191029790754985' },
        contacts: [{ profile: { name: 'Gate' } }],
        messages: [{ id: 'wamid.GATE_F', type: 'text', timestamp: '1780000000', text: { body: 'سؤال سري' } }],
      }))
      await delay(1500)
      const n = (await c.query(
        `SELECT count(*)::int AS n FROM "UnidentifiedInbound" WHERE wamid=$1`, ['wamid.GATE_F'])).rows[0].n
      t(n === 1, 'a redelivered webhook does not double-count', `rows=${n}`)
    }

    // ── H. PHASE 3b — a BSUID-only customer becomes VISIBLE ──────────────────
    // Before 3b this message was dropped and the customer was lost. A row nobody
    // can see would be the same outage with better records, so this asserts the
    // conversation reaches the sales inbox query, not merely the database.
    console.log('\nH. BSUID-only inbound (Phase 3b)')
    const ONLY_BSUID = 'EG.55554444333322221111'
    await c.query(`DELETE FROM "Conversation" WHERE "waUserId"=$1`, [ONLY_BSUID]).catch(() => {})
    {
      const b = logs.length
      const status = await post(envelope({
        metadata: { phone_number_id: process.env.GATE_PHONE_ID || '1191029790754985' },
        contacts: [{ profile: { name: 'Gate' }, user_id: ONLY_BSUID }],   // NO wa_id
        messages: [{ id: 'wamid.GATE_H', type: 'text', timestamp: '1780000000', text: { body: 'السلام عليكم' } }],
      }))
      await settle()
      t(status === 200, 'accepted')

      const conv = (await c.query(
        `SELECT id, phone, "waUserId", "companyId", status, "isTest"
           FROM "Conversation" WHERE "waUserId"=$1`, [ONLY_BSUID])).rows[0]
      t(!!conv, 'a conversation was CREATED from a BSUID alone')
      if (conv) {
        t(conv.phone === null, 'its phone is null — no placeholder was invented', `got ${conv.phone}`)
        t(conv.waUserId === ONLY_BSUID, 'keyed by the BSUID')

        // The sales inbox query: companyId + not a test conversation. If this row
        // does not match it, the customer is invisible and 3b has failed its purpose.
        const inbox = (await c.query(
          `SELECT id FROM "Conversation"
            WHERE "companyId"=$1 AND "isTest"=false AND id=$2`, [conv.companyId, conv.id])).rows
        t(inbox.length === 1, 'APPEARS in the sales inbox query — visible, not just recorded')

        const msgs = (await c.query(
          `SELECT role FROM "Message" WHERE "conversationId"=$1 ORDER BY "createdAt"`, [conv.id])).rows
        t(msgs.some(m => m.role === 'USER'), 'the inbound message is stored on it')

        // It must NOT be recorded as lost any more — that was the old behaviour.
        const lost = (await c.query(
          `SELECT count(*)::int n FROM "UnidentifiedInbound" WHERE wamid=$1`, ['wamid.GATE_H'])).rows[0].n
        t(lost === 0, 'NOT written to UnidentifiedInbound — it is no longer a lost customer')
        t(!logs.slice(b).join('').includes('WEBHOOK_NO_IDENTITY'), 'no unidentified alarm fired')
      }
      await c.query(`DELETE FROM "Message" WHERE "conversationId" IN (SELECT id FROM "Conversation" WHERE "waUserId"=$1)`, [ONLY_BSUID])
      await c.query(`DELETE FROM "Conversation" WHERE "waUserId"=$1`, [ONLY_BSUID])
    }

    // ── I. THE NO-REGRESSION INVARIANT — asserted, not inferred ──────────────
    // "The other suites still pass" is not the same claim. This states directly
    // that a phone-only inbound produces exactly what it produced before 3b.
    console.log('\nI. phone-only inbound is unchanged')
    {
      await nuke()
      await post(textMsg('wamid.GATE_I', {}, PHONE))    // no user_id at all
      await settle()
      const conv = (await c.query(
        `SELECT id, phone, "waUserId", "leadId", status, "agentMode"
           FROM "Conversation" WHERE phone=$1 AND "companyId"=$2`, [PHONE, CO])).rows[0]
      t(!!conv, 'conversation created')
      if (conv) {
        t(conv.phone === PHONE, 'keyed by phone exactly as before', `got ${conv.phone}`)
        t(conv.waUserId === null, 'no BSUID invented when Meta sent none')
        t(!!conv.leadId, 'a Lead is attached, as before')
        const lead = (await c.query(`SELECT phone FROM "Lead" WHERE id=$1`, [conv.leadId])).rows[0]
        t(lead && lead.phone === PHONE, 'the Lead carries the phone, as before', `got ${lead && lead.phone}`)
        const msgs = (await c.query(
          `SELECT role FROM "Message" WHERE "conversationId"=$1`, [conv.id])).rows
        t(msgs.some(m => m.role === 'USER'), 'inbound stored')
        // No ASSISTANT assertion: CompanyAIConfig.isActive is false, so new
        // conversations are created agentMode='HUMAN' and the real webhook path
        // deliberately produces no AI reply. Asserting a reply would encode the
        // kill switch being ON.
        t(conv.agentMode === 'HUMAN', `agentMode is HUMAN while the AI kill switch is off (${conv.agentMode})`)
      }
    }

    // ── J. two phone-less customers must NEVER collide ───────────────────────
    // The dangerous shape: findFirst({ phone: null }) matches ANY phone-less row.
    // If resolution ever falls back to phone when it is null, one customer is
    // handed another's thread — silently, on their first message.
    console.log('\nJ. two different BSUID-only customers stay separate')
    const B1 = 'EG.11112222333344445555', B2 = 'EG.66667777888899990000'
    for (const b of [B1, B2]) await c.query(`DELETE FROM "Conversation" WHERE "waUserId"=$1`, [b]).catch(() => {})
    {
      for (const [id, b] of [['wamid.GATE_J1', B1], ['wamid.GATE_J2', B2]]) {
        await post(envelope({
          metadata: { phone_number_id: process.env.GATE_PHONE_ID || '1191029790754985' },
          contacts: [{ profile: { name: 'Gate' }, user_id: b }],
          messages: [{ id, type: 'text', timestamp: '1780000000', text: { body: 'اهلا' } }],
        }))
        await settle()
      }
      const rows = (await c.query(
        `SELECT "waUserId", id FROM "Conversation" WHERE "waUserId" IN ($1,$2)`, [B1, B2])).rows
      t(rows.length === 2, 'two SEPARATE conversations, not one shared thread', `got ${rows.length}`)
      t(new Set(rows.map(r => r.id)).size === 2, 'distinct conversation ids')
      for (const b of [B1, B2]) {
        await c.query(`DELETE FROM "Message" WHERE "conversationId" IN (SELECT id FROM "Conversation" WHERE "waUserId"=$1)`, [b])
        await c.query(`DELETE FROM "Conversation" WHERE "waUserId"=$1`, [b])
      }
    }

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
