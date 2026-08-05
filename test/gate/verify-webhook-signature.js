/**
 * POST-DEPLOY WEBHOOK SIGNATURE VERIFICATION
 *
 * Run IMMEDIATELY after deploying the X-Hub-Signature-256 change. Proves the
 * HMAC ACCEPTS correctly-signed traffic — not merely that it rejects forgeries.
 *
 * Zero side effects: every probe carries a bogus phone_number_id, so once a
 * request is accepted it hits the "Unknown waPhoneId" guard and returns before
 * any DB write, AI call, or WhatsApp send.
 *
 * The script detects the rollout mode from the responses:
 *   WARN    (META_SIGNATURE_ENFORCE unset) — forgeries logged but accepted
 *   ENFORCE (META_SIGNATURE_ENFORCE=true)  — forgeries rejected with 403
 *
 * In BOTH modes a correctly-signed request must return 200. If it does not,
 * real customer messages are being dropped — roll back (SECURITY.md).
 *
 * Usage:
 *   META_APP_SECRET=<secret> node test/gate/verify-webhook-signature.js
 *   META_APP_SECRET=<secret> HOST=localhost PORT=3001 node test/gate/verify-webhook-signature.js
 *   node test/gate/verify-webhook-signature.js --check-inbound   (Probe B, see below)
 *
 * LIMITATION — read this:
 *   This script signs payloads with OUR implementation. It proves the accept
 *   path, the rawBody plumbing, and the secret all work together. It CANNOT
 *   prove our HMAC matches Meta's, because the signature is not produced by
 *   Meta. Only Probe B does that. Run both.
 */
'use strict'
const https = require('https')
const http  = require('http')
const { createHmac } = require('crypto')

// PORT applies only when HOST is overridden for a local run; production is always 443.
const HOST_OVERRIDE = process.env.HOST
const HOST   = HOST_OVERRIDE || 'tutix-ai-crm-production.up.railway.app'
const PORT   = HOST_OVERRIDE ? parseInt(process.env.PORT || '3001', 10) : 443
const SECRET = process.env.META_APP_SECRET
const client = PORT === 443 ? https : http

// Bogus phone_number_id on purpose — no company matches, so nothing is written.
const PROBE_BODY = {
  entry: [{
    changes: [{
      value: {
        metadata: { phone_number_id: 'SIGNATURE_PROBE_NOT_A_REAL_PHONE_ID' },
        messages: [{
          from: '200000000000',
          id:   'wamid.signature_probe_' + Date.now(),
          type: 'text',
          text: { body: 'signature probe — ignore' },
        }],
      },
    }],
  }],
}

function post(rawBody, signature) {
  return new Promise((resolve, reject) => {
    const req = client.request({
      hostname: HOST, port: PORT, path: '/webhook', method: 'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(rawBody),
        ...(signature && { 'X-Hub-Signature-256': signature }),
      },
    }, res => { let b = ''; res.on('data', d => b += d); res.on('end', () => resolve({ status: res.statusCode, body: b.slice(0, 120) })) })
    req.on('error', reject)
    req.setTimeout(25000, () => { req.destroy(); reject(new Error('timeout')) })
    req.write(rawBody); req.end()
  })
}

const sign = (raw, secret) => 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex')

async function checkInbound() {
  const { Pool } = require('pg')
  require('dotenv').config()
  const PHONE   = process.env.PROBE_PHONE || '201091656041'
  const COMPANY = process.env.DEFAULT_COMPANY_ID
  const pool = new Pool({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL })
  const c = await pool.connect()
  try {
    const r = await c.query(
      `SELECT m.role, LEFT(m.content, 60) AS content,
              to_char(m."createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS ts
         FROM "Message" m
         JOIN "Conversation" conv ON conv.id = m."conversationId"
        WHERE conv.phone = $1 AND conv."companyId" = $2
        ORDER BY m."createdAt" DESC LIMIT 5`, [PHONE, COMPANY])
    console.log(`\nLast 5 messages for ${PHONE} (UTC):`)
    if (r.rows.length === 0) console.log('  (none)')
    r.rows.forEach(x => console.log(`  ${x.ts} | ${String(x.role).padEnd(9)} | ${x.content}`))
    console.log('\nA USER row timestamped after you sent the WhatsApp message = Meta-signed request ACCEPTED.')
    console.log('No new row + WEBHOOK_SIG_REJECT in Railway logs = REJECTED — roll back (see SECURITY.md).')
  } finally { c.release(); await pool.end() }
}

;(async () => {
  if (process.argv.includes('--check-inbound')) return checkInbound()

  if (!SECRET) {
    console.error('FATAL: META_APP_SECRET not set. Pass the same value configured on Railway.')
    console.error('Never hardcode it — export it for this shell only.')
    process.exit(1)
  }

  const raw = JSON.stringify(PROBE_BODY)
  console.log(`Target: ${HOST}:${PORT}/webhook\n`)

  const send = async sig => {
    try { return (await post(raw, sig)).status } catch (e) { return 0 }
  }

  // A valid signature must be accepted in BOTH modes — this is the check that
  // matters for live traffic.
  const good = await send(sign(raw, SECRET))
  // Forgeries: 200 in warn mode (logged, accepted), 403 under enforcement.
  const none = await send(undefined)
  const bad  = await send(sign(raw, SECRET + '-wrong'))
  const tam  = await send(sign(raw + ' ', SECRET))

  const forged = [none, bad, tam]
  const mode = forged.every(s => s === 403) ? 'ENFORCE'
             : forged.every(s => s === 200) ? 'WARN'
             : 'INCONSISTENT'

  console.log(`correctly signed        → ${good}  ${good === 200 ? '✅ accepted' : '❌ MUST be 200 — real messages are being dropped'}`)
  console.log(`unsigned                → ${none}`)
  console.log(`wrong secret            → ${bad}`)
  console.log(`tampered after signing  → ${tam}`)
  console.log(`\nDetected mode: ${mode}`)

  let allOk = good === 200
  if (mode === 'WARN') {
    console.log('  WARN mode — forged requests are LOGGED but still processed. Zero risk to')
    console.log('  live traffic, but the hole is not closed yet. Watch the hourly [SIG_SUMMARY]')
    console.log('  line in Railway logs; flip META_SIGNATURE_ENFORCE=true once fail=0.')
  } else if (mode === 'ENFORCE') {
    console.log('  ENFORCE mode — forged requests rejected. The hole is closed.')
  } else {
    allOk = false
    console.log('  ❌ INCONSISTENT — some forgeries accepted, some rejected. Investigate before proceeding.')
  }

  console.log(allOk
    ? '\n✅ ACCEPT PATH VERIFIED — correctly-signed requests are accepted.'
    : '\n❌ FAILED — see SECURITY.md → Rollback.')
  console.log('\nNow run Probe B (genuine Meta signature) — this script cannot substitute for it:')
  console.log('  1. Meta App Dashboard → WhatsApp → Configuration → Webhooks → Test the "messages" field, OR')
  console.log('  2. Send one real WhatsApp message from the test phone to the business number, then:')
  console.log('     node test/gate/verify-webhook-signature.js --check-inbound')
  process.exit(allOk ? 0 : 1)
})()
