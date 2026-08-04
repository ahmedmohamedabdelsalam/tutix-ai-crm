/**
 * HAJJ PRODUCTION VERIFICATION
 *
 * Drives the LIVE backend with real hajj queries and diffs every reply against
 * test/gate/hajj-golden.json. Run it twice:
 *
 *   before the flip (USE_DB_HAJJ off) → proves the harness + live JSON path agree
 *   after  the flip (USE_DB_HAJJ on)  → proves the Offerings path is identical live
 *
 * A clean run after the flip is the gate for unlocking the admin screen.
 *
 * Safety: simulate=true (zero WhatsApp sends), test phone only. It deletes the test
 * phone's own conversations between probes so each starts from a known state — the
 * same nukeAll pattern the gate suites use. No other rows are touched.
 *
 *   node test/gate/hajj-prod-verify.js
 *   HOST=localhost PORT=3001 node test/gate/hajj-prod-verify.js
 */
'use strict'
const https = require('https')
const http  = require('http')
const fs    = require('fs')
const path  = require('path')
const { Pool } = require('pg')
require('dotenv').config()

// PORT applies only when HOST is overridden for a local run. Production is always
// 443 — .env sets PORT=3001 for the local server, which must not leak into the
// production target.
const HOST_OVERRIDE = process.env.HOST
const HOST    = HOST_OVERRIDE || 'tutix-ai-crm-production.up.railway.app'
const PORT    = HOST_OVERRIDE ? parseInt(process.env.PORT || '3001', 10) : 443
const client  = PORT === 443 ? https : http
const PHONE   = '201091656041'
const COMPANY = process.env.DEFAULT_COMPANY_ID
const TOKEN   = process.env.TEST_ENDPOINT_TOKEN   // only needed once the endpoint is locked

const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'hajj-golden.json'), 'utf8'))
const pool = new Pool({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL })

// applyHajjDateDisclaimer appends this to any reply mentioning ذي الحجة ١٤٤٨.
// It is added downstream of the catalog strings, so strip it before comparing.
const DISCLAIMER_RE = /\n*ملاحظة: التواريخ الهجرية لبرامج الحج ١٤٤٨هـ تقديرية[^\n]*/g
const strip = s => String(s ?? '').replace(DISCLAIMER_RE, '').trim()

function post(body) {
  const data = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = client.request({
      hostname: HOST, port: PORT, path: '/webhook/test', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...(TOKEN && { 'X-Internal-Token': TOKEN }),
      },
    }, res => { let b = ''; res.on('data', d => b += d); res.on('end', () => resolve({ status: res.statusCode, body: b })) })
    req.on('error', reject)
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('timeout')) })
    req.write(data); req.end()
  })
}

async function send(message) {
  const r = await post({ phone: PHONE, message, simulate: true })
  if (r.status !== 200 && r.status !== 201) throw new Error(`HTTP ${r.status}: ${r.body.slice(0, 200)}`)
  let j; try { j = JSON.parse(r.body) } catch { throw new Error('non-JSON reply: ' + r.body.slice(0, 200)) }
  if (j.error) throw new Error(j.error)
  return j.replies || (j.reply ? [j.reply] : [])
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

function report(label, expected, actual) {
  const e = strip(expected), a = strip(actual)
  if (e === a) { console.log(`  ✅ ${label}`); return true }
  console.log(`  ❌ ${label}`)
  let i = 0; while (i < e.length && i < a.length && e[i] === a[i]) i++
  console.log(`     first difference at char ${i} (golden ${e.length} chars, live ${a.length})`)
  console.log(`     golden: ${JSON.stringify(e.slice(Math.max(0, i - 50), i + 90))}`)
  console.log(`     live:   ${JSON.stringify(a.slice(Math.max(0, i - 50), i + 90))}`)
  return false
}

;(async () => {
  console.log(`Target: ${HOST}:${PORT}  phone=${PHONE}\n`)
  let pass = 0, fail = 0
  const t = (ok) => ok ? pass++ : fail++

  try {
    // 1. Generic hajj question → category question
    await nuke()
    t(report('hajjCategoryQuestion', golden.hajjCategoryQuestion, (await send('عايز اعرف عن برامج الحج')).at(-1)))

    // 2-3. Category overviews reachable straight from an intent.
    //      detectHajjOverviewIntent only returns ECONOMY / FIVE_STAR / GENERIC —
    //      the text must contain حج, and there is no KADAN branch.
    for (const [key, q] of [
      ['hajjEconomyPrograms',  'عايز برامج الحج الاقتصادية'],
      ['hajjFiveStarPrograms', 'عايز برامج الحج خمس نجوم'],
    ]) {
      await nuke()
      t(report(key, golden[key], (await send(q)).at(-1)))
    }

    // 4. KADAN is only reachable as a reply to the category question (٣ / كدانة).
    await nuke()
    await send('عايز اعرف عن برامج الحج')
    t(report('hajjKadanPrograms (via category reply ٣)', golden.hajjKadanPrograms, (await send('٣')).at(-1)))

    // 5. Number reply inside a category → hajj{Cat}Details[n-1].
    //    Ordering contract: a shifted list silently delivers the wrong program.
    const numberProbes = [
      ['ECONOMY',   'عايز برامج الحج الاقتصادية', 'hajjEconomyDetails',  [1, 3]],
      ['FIVE_STAR', 'عايز برامج الحج خمس نجوم',   'hajjFiveStarDetails', [1, 2]],
    ]
    for (const [, query, key, nums] of numberProbes) {
      for (const n of nums) {
        await nuke()
        await send(query)
        t(report(`${key}[${n - 1}] (reply "${n}")`, golden[key][n - 1], (await send(String(n))).at(-1)))
      }
    }

    // 6. Chunked full-details — renders hajjProgramDetails in RAW ARRAY ORDER,
    //    the surface where the H4 ordering bug lived. 3 per message + a closing line.
    await nuke()
    await send('عايز اعرف عن برامج الحج')
    const chunk1 = (await send('اعرضهم كلهم بالتفصيل')).at(-1)
    const expected1 = golden.hajjProgramDetails.slice(0, 3).join('\n\n')
    t(report('hajjProgramDetails[0..2] (full-details chunk 1)',
      expected1, strip(chunk1).replace(/\n*دول [٠-٩]+ من [٠-٩]+ يافندم[^\n]*$/, '')))

    const chunk2 = (await send('كمل')).at(-1)
    const expected2 = golden.hajjProgramDetails.slice(3, 6).join('\n\n')
    t(report('hajjProgramDetails[3..5] (full-details chunk 2)',
      expected2, strip(chunk2).replace(/\n*دول [٠-٩]+ من [٠-٩]+ يافندم[^\n]*$/, '')))
  } catch (e) {
    console.error(`\nFATAL: ${e.message}`)
    fail++
  } finally {
    try { await nuke() } catch {}
    await pool.end()
  }

  console.log('\n  ℹ  hajjOverviewMessage / hajjOverviewDetails are built by the catalog but')
  console.log('     read by no handler — there is no customer path that emits them, so they')
  console.log('     cannot be probed live. They are covered by the H4 offline diff.')

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`)
  console.log(fail === 0
    ? 'Live backend matches the golden baseline on every hajj surface probed.'
    : 'DIFFERENCES FOUND — do not unlock the admin screen.')
  process.exit(fail === 0 ? 0 : 1)
})()
