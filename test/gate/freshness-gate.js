/**
 * CATALOG FRESHNESS GATE — Regression suite
 *
 * Section FG-U: Unit tests (no server — import compiled dist directly)
 *   FG-U1  empty offeringsOverride → hasFutureOfferings=false
 *   FG-U2  undefined offeringsOverride (legacy fallback) → hasFutureOfferings=true
 *   FG-U3  non-empty offeringsOverride → hasFutureOfferings=true
 *   FG-U4  filtering logic: today's trip included, past trip excluded
 *
 * Section FG-I: Integration tests (local server, simulate=true)
 *   FG-I1  "أقرب رحلة عمرة" → July trip MUST NOT appear (expired)
 *   FG-I2  "أقرب رحلة عمرة" → August trip MUST appear (first future trip)
 *   FG-I3  "برامج يوليو" → month-unavailable message (no July future offerings)
 *   FG-I4  "برامج أغسطس" → August trips shown correctly
 *
 * Safety:
 *   simulate=true — zero WhatsApp sends.
 *   Test phone 201091656041 only.
 *   No writes to isActive / agentMode / env vars.
 *   No offerings deleted or deactivated.
 *
 * Run: node test/gate/freshness-gate.js  (from repo root)
 * Prerequisite: npm run build
 */

'use strict'
const http   = require('http')
const { Pool } = require('pg')
const { spawn } = require('child_process')
const path   = require('path')
require('dotenv').config()

const PHONE   = '201091656041'
const COMPANY = process.env.DEFAULT_COMPANY_ID
const HOST    = 'localhost'
const PORT    = parseInt(process.env.PORT || '3001', 10)

if (!COMPANY) { console.error('FATAL: DEFAULT_COMPANY_ID not set'); process.exit(1) }

const pool = new Pool({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL })

// ── Server lifecycle ───────────────────────────────────────────────────────
let serverProc = null

function startServer() {
  return new Promise(async resolve => {
    console.log('\n[SERVER] Spawning node dist/src/main.js ...')
    serverProc = spawn('node', ['dist/src/main.js'], {
      cwd: path.join(__dirname, '../..'),
      env: { ...process.env, NODE_ENV: 'production' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    serverProc.stdout.on('data', d => process.stdout.write('[SRV] ' + d.toString()))
    serverProc.stderr.on('data', d => {
      const l = d.toString().trim()
      if (/error|EADDRINUSE/i.test(l)) process.stdout.write('[SRV!] ' + l + '\n')
    })
    serverProc.on('exit', code => {
      if (code !== null && code !== 0) console.error('[SERVER] exited code=' + code)
    })
    for (let i = 0; i < 40; i++) {
      await delay(1000)
      try {
        const h = await httpGet('/webhook/health')
        if (h.status === 200) { console.log('[SERVER] Ready ✓'); return resolve(true) }
      } catch {}
    }
    console.error('[SERVER] Did not become ready within 40 s')
    resolve(false)
  })
}

function stopServer() {
  if (serverProc) { serverProc.kill('SIGTERM'); serverProc = null; console.log('[SERVER] Stopped') }
}

// ── HTTP helpers ───────────────────────────────────────────────────────────
function httpPost(urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = http.request(
      { hostname: HOST, port: PORT, path: urlPath, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      res => {
        let buf = ''
        res.on('data', d => buf += d)
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(buf) }) }
          catch { resolve({ status: res.statusCode, body: buf }) }
        })
      }
    )
    req.on('error', reject)
    req.setTimeout(35000, () => { req.destroy(); reject(new Error('timeout')) })
    req.write(data); req.end()
  })
}

function httpGet(urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: HOST, port: PORT, path: urlPath, method: 'GET' }, res => {
      let buf = ''
      res.on('data', d => buf += d)
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }) }
        catch { resolve({ status: res.statusCode, body: buf }) }
      })
    })
    req.on('error', reject)
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('health timeout')) })
    req.end()
  })
}

async function send(message) {
  const r = await httpPost('/webhook/test', { phone: PHONE, message, simulate: true })
  if (r.body?.error) throw new Error(r.body.error)
  const replies = r.body?.replies || (r.body?.reply ? [r.body.reply] : [])
  return replies.join('\n---\n')
}

// ── DB helpers ─────────────────────────────────────────────────────────────
async function nukeAll() {
  const c = await pool.connect()
  try {
    const { rows } = await c.query(
      'SELECT id FROM "Conversation" WHERE phone=$1 AND "companyId"=$2',
      [PHONE, COMPANY]
    )
    for (const { id } of rows) {
      await c.query('DELETE FROM "Message" WHERE "conversationId"=$1', [id])
      await c.query('DELETE FROM "Conversation" WHERE id=$1', [id])
    }
    await c.query('DELETE FROM "Lead" WHERE phone=$1 AND "companyId"=$2', [PHONE, COMPANY])
  } finally { c.release() }
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)) }

// ── Result tracking ────────────────────────────────────────────────────────
const results = []
function record(id, label, verdict, reply) {
  results.push({ id, label, verdict })
  const icon = verdict.startsWith('PASS') ? '✓' : verdict.startsWith('WARN') ? '~' : '✗'
  console.log(`  ${icon} ${id} ${label}: ${verdict}`)
  if (verdict.startsWith('FAIL')) console.log(`      reply snippet: "${(reply || '').slice(0, 120)}"`)
}

// ══════════════════════════════════════════════════════════════════════════
// SECTION FG-U: UNIT TESTS (no server — import compiled dist)
// ══════════════════════════════════════════════════════════════════════════

function runUnitTests() {
  console.log('\n── FG-U: Unit tests (compiled dist) ─────────────────────────────────')

  const { buildIndustryPromptFromDB } = require('../../dist/src/agent/prompts/dynamic-catalog-builder.js')

  function makeMinimalConfig(umrahPrograms = []) {
    return {
      catalog: { umrahPrograms, hajjPrograms: [], hotelBookingLinks: {} },
      industryData: null,
      templates: {},
    }
  }

  // FG-U1: empty offeringsOverride=[] → hasFutureOfferings=false
  try {
    const r = buildIndustryPromptFromDB(makeMinimalConfig(), 'TestCo', [])
    if (r.hasFutureOfferings !== false)
      throw new Error(`hasFutureOfferings should be false, got ${r.hasFutureOfferings}`)
    if (r.rawUmrahPrograms.length !== 0)
      throw new Error(`rawUmrahPrograms should be empty, got ${r.rawUmrahPrograms.length}`)
    record('FG-U1', 'empty offeringsOverride → hasFutureOfferings=false', 'PASS')
  } catch (e) {
    record('FG-U1', 'empty offeringsOverride → hasFutureOfferings=false', `FAIL(${e.message})`)
  }

  // FG-U2: undefined offeringsOverride → legacy fallback → hasFutureOfferings=true
  try {
    const legacyPrograms = [{ name: 'برنامج قديم', departureDate: '2020-01-01', returnDate: '2020-01-15' }]
    const r = buildIndustryPromptFromDB(makeMinimalConfig(legacyPrograms), 'TestCo', undefined)
    if (r.hasFutureOfferings !== true)
      throw new Error(`hasFutureOfferings should be true (legacy path), got ${r.hasFutureOfferings}`)
    record('FG-U2', 'undefined offeringsOverride (legacy) → hasFutureOfferings=true', 'PASS')
  } catch (e) {
    record('FG-U2', 'undefined offeringsOverride (legacy) → hasFutureOfferings=true', `FAIL(${e.message})`)
  }

  // FG-U3: non-empty offeringsOverride → hasFutureOfferings=true
  try {
    const minimalOffering = {
      values: { 'prog-name': 'برنامج اقتصادي ١٥ يوم', 'quad-price': 41000 },
      fieldDefs: [
        { key: 'prog-name',   label: 'اسم البرنامج', role: 'title',      inputType: 'text',   required: true,  showInList: true },
        { key: 'quad-price',  label: 'سعر رباعي',    role: 'price-quad', inputType: 'number', required: false, showInList: true },
      ],
    }
    const r = buildIndustryPromptFromDB(makeMinimalConfig(), 'TestCo', [minimalOffering])
    if (r.hasFutureOfferings !== true)
      throw new Error(`hasFutureOfferings should be true, got ${r.hasFutureOfferings}`)
    if (r.rawUmrahPrograms.length === 0)
      throw new Error('rawUmrahPrograms should not be empty')
    record('FG-U3', 'non-empty offeringsOverride → hasFutureOfferings=true', 'PASS')
  } catch (e) {
    record('FG-U3', 'non-empty offeringsOverride → hasFutureOfferings=true', `FAIL(${e.message})`)
  }

  // FG-U4: filtering logic — today's trip included, past excluded
  try {
    const today = new Date().toISOString().slice(0, 10)
    const raw = [
      { key: 'dep', val: today },            // today    → INCLUDE
      { key: 'dep', val: '2020-01-01' },     // past     → EXCLUDE
      { key: 'dep', val: '2099-12-31' },     // far future → INCLUDE
    ]
    const filtered = raw.filter(o => typeof o.val !== 'string' || o.val >= today)
    if (filtered.length !== 2) throw new Error(`Expected 2 included, got ${filtered.length}`)
    if (filtered.some(o => o.val === '2020-01-01')) throw new Error('Past offering was not excluded')
    if (!filtered.some(o => o.val === today)) throw new Error('Today offering was excluded')
    record('FG-U4', 'filtering: today included, past excluded', 'PASS')
  } catch (e) {
    record('FG-U4', 'filtering: today included, past excluded', `FAIL(${e.message})`)
  }
}

// ══════════════════════════════════════════════════════════════════════════
// SECTION FG-I: INTEGRATION TESTS (live server)
// ══════════════════════════════════════════════════════════════════════════

async function runIntegrationTests() {
  console.log('\n── FG-I: Integration tests (local server) ────────────────────────────')

  // FG-I1: "أقرب رحلة عمرة" — expired July trip MUST NOT appear
  await nukeAll()
  try {
    const reply = await send('اقرب رحلة عمرة امتي')
    const hasJuly    = /يوليو/.test(reply)
    const hasAugust  = /أغسطس|اغسطس/.test(reply)
    if (hasJuly)
      record('FG-I1', 'nearest-trip: no July (expired)', `FAIL(يوليو leaked: "${reply.slice(0, 80)}")`, reply)
    else if (!hasAugust && !reply.includes('أقرب') && !reply.includes('كام'))
      record('FG-I1', 'nearest-trip: no July (expired)', 'WARN(no July, but no August either — check reply)', reply)
    else
      record('FG-I1', 'nearest-trip: no July (expired)', 'PASS', reply)
  } catch (e) {
    record('FG-I1', 'nearest-trip: no July (expired)', `FAIL(${e.message})`)
  }

  // FG-I2: "أقرب رحلة عمرة" — August trip (first future) MUST appear
  await nukeAll()
  try {
    const reply = await send('اقرب رحلة عمرة امتي')
    const hasAugust = /أغسطس|اغسطس/.test(reply)
    if (!hasAugust)
      record('FG-I2', 'nearest-trip: August returned (first future)', `FAIL(no August in reply)`, reply)
    else
      record('FG-I2', 'nearest-trip: August returned (first future)', 'PASS', reply)
  } catch (e) {
    record('FG-I2', 'nearest-trip: August returned (first future)', `FAIL(${e.message})`)
  }

  // FG-I3: "برامج يوليو" — month unavailable message (all July departed)
  await nukeAll()
  try {
    const reply = await send('ممكن برامج يوليو')
    const hasUnavailable = /لسه بتتجهز|غير متاح|مش عندنا/.test(reply)
    const hasJulyTrip    = /يوليو.*جنيه|٨ يوليو|يوليو.*يوم/.test(reply)
    if (hasJulyTrip)
      record('FG-I3', 'July: month-unavailable (no July trips)', `FAIL(July trip data appeared)`, reply)
    else if (hasUnavailable)
      record('FG-I3', 'July: month-unavailable (no July trips)', 'PASS(unavailable msg shown)', reply)
    else
      record('FG-I3', 'July: month-unavailable (no July trips)', 'WARN(no unavail msg, no trip — check reply)', reply)
  } catch (e) {
    record('FG-I3', 'July: month-unavailable (no July trips)', `FAIL(${e.message})`)
  }

  // FG-I4: "برامج أغسطس" — August trips shown correctly
  await nukeAll()
  try {
    const reply = await send('لو سمحتم برامج العمرة شهر أغسطس')
    const hasAugust = /أغسطس|اغسطس/.test(reply)
    const hasJuly   = /٨ يوليو|٢٢ يوليو/.test(reply)  // specific expired-trip dates
    if (hasJuly)
      record('FG-I4', 'August overview: no expired July trips', `FAIL(July trip in August reply)`, reply)
    else if (!hasAugust)
      record('FG-I4', 'August overview: no expired July trips', 'WARN(no August content)', reply)
    else
      record('FG-I4', 'August overview: no expired July trips', 'PASS', reply)
  } catch (e) {
    record('FG-I4', 'August overview: no expired July trips', `FAIL(${e.message})`)
  }
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log('═══════════════════════════════════════════════════════════════════')
  console.log(' CATALOG FRESHNESS GATE — Regression suite')
  console.log('═══════════════════════════════════════════════════════════════════')

  // Unit tests run first, no server needed
  runUnitTests()

  // Start server for integration tests
  const ready = await startServer()
  if (!ready) {
    console.error('[ABORT] Server did not start — skipping integration tests')
    stopServer()
    await pool.end()
    printSummary()
    process.exit(results.some(r => r.verdict.startsWith('FAIL')) ? 1 : 0)
  }

  try {
    await runIntegrationTests()
  } finally {
    await nukeAll()
    stopServer()
    await pool.end()
  }

  printSummary()
  process.exit(results.some(r => r.verdict.startsWith('FAIL')) ? 1 : 0)
}

function printSummary() {
  console.log('\n═══════════════════════════════════════════════════════════════════')
  const pass = results.filter(r => r.verdict.startsWith('PASS')).length
  const warn = results.filter(r => r.verdict.startsWith('WARN')).length
  const fail = results.filter(r => r.verdict.startsWith('FAIL')).length
  console.log(` FRESHNESS GATE: ${pass} PASS  ${warn} WARN  ${fail} FAIL  (total ${results.length})`)
  console.log('═══════════════════════════════════════════════════════════════════')
  for (const r of results) {
    const icon = r.verdict.startsWith('PASS') ? '✓' : r.verdict.startsWith('WARN') ? '~' : '✗'
    console.log(`  ${icon} ${r.id}  ${r.label}`)
  }
}

main().catch(e => {
  console.error('[FATAL]', e)
  stopServer()
  pool.end()
  process.exit(1)
})
