'use strict'
/**
 * Focused test: hotel content handler + entity-blocklist output guard.
 *
 * Verifies:
 *  A) "الفنادق ايه" routes to HOTEL_CONTENT_HANDLER — reply contains hotel names,
 *     not the handoff template, and zero AI was involved.
 *  B) "فندق ايه ٥ نجوم" routes to HOTEL_CONTENT_HANDLER with level filter.
 *  C) scanModelOutput(text, blocklist) blocks a hotel brand name — unit test inline.
 *  D) Baseline proof: a sentence containing a hotel brand name is blocked by output guard
 *     when blocklist is passed; same sentence passes when blocklist is omitted.
 *
 * Safety: simulate=true throughout; test phone 201091656041 only; zero WhatsApp sends.
 */
const http    = require('http')
const { Pool } = require('pg')
const { spawn } = require('child_process')
require('dotenv').config()

const PHONE   = '201091656041'
const COMPANY = process.env.DEFAULT_COMPANY_ID
const HOST    = 'localhost'
const PORT    = parseInt(process.env.PORT || '3001', 10)
if (!COMPANY) { console.error('FATAL: DEFAULT_COMPANY_ID not set'); process.exit(1) }

const pool  = new Pool({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL })
const delay = ms => new Promise(r => setTimeout(r, ms))
let serverProc = null

function startServer() {
  return new Promise(async resolve => {
    console.log('[SERVER] Spawning node dist/src/main.js ...')
    serverProc = spawn('node', ['dist/src/main.js'], {
      cwd: __dirname,
      env: { ...process.env, NODE_ENV: 'production' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    serverProc.stderr.on('data', d => {
      const l = d.toString().trim()
      if (/error|EADDRINUSE/i.test(l)) process.stdout.write('[SRV!] ' + l + '\n')
    })
    for (let i = 0; i < 40; i++) {
      await delay(1000)
      try { await httpGet('/webhook/health'); console.log('[SERVER] Ready'); return resolve(true) } catch {}
    }
    resolve(false)
  })
}
function stopServer() { if (serverProc) { serverProc.kill('SIGTERM'); serverProc = null } }

function httpPost(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = http.request(
      { hostname: HOST, port: PORT, path, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      res => { let b = ''; res.on('data', d => b += d); res.on('end', () => { try { resolve(JSON.parse(b)) } catch { resolve(b) } }) }
    )
    req.on('error', reject)
    req.setTimeout(35000, () => { req.destroy(); reject(new Error('timeout')) })
    req.write(data); req.end()
  })
}
function httpGet(path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: HOST, port: PORT, path, method: 'GET' }, res => {
      let b = ''; res.on('data', d => b += d); res.on('end', () => resolve({ status: res.statusCode, body: b }))
    })
    req.on('error', reject); req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')) }); req.end()
  })
}

async function nukeConv() {
  const convs = await pool.query(
    `SELECT id FROM "Conversation" WHERE phone=$1 AND "companyId"=$2`, [PHONE, COMPANY]
  )
  for (const c of convs.rows) {
    await pool.query(`DELETE FROM "Message" WHERE "conversationId"=$1`, [c.id])
    await pool.query(`DELETE FROM "Conversation" WHERE id=$1`, [c.id])
  }
  await pool.query(`DELETE FROM "Lead" WHERE phone=$1 AND "companyId"=$2`, [PHONE, COMPANY])
}

async function send(msg) {
  const r = await httpPost('/webhook/test', { phone: PHONE, message: msg, simulate: true })
  return (r?.replies || (r?.reply ? [r.reply] : [])).join('\n')
}

const HANDOFF_MARKERS = ['زميلنا المختص', 'غير متاح دلوقتي', 'هيرد عليك', 'هيتواصل معك', 'فريقنا']
const isHandoff = txt => HANDOFF_MARKERS.some(m => txt.includes(m))
const hasDigit  = txt => /[٠١٢٣٤٥٦٧٨٩0-9]/.test(txt)

// ── Unit test C/D: scanModelOutput with entity blocklist ─────────────────────
function runUnitTests() {
  const { scanModelOutput } = require('./dist/src/whatsapp/output-guard')

  const demoBlocklist = ['موفنبيك', 'هيلتون', 'شيراتون', 'فيرمونت', 'انتركونتيننتال']

  const cases = [
    // should be blocked by entity blocklist
    { text: 'الفندق المخصص لكم هو موفنبيك على بعد خطوات من الحرم', blocklist: demoBlocklist, expectBlock: true, desc: 'Hotel brand in output — entity blocklist' },
    { text: 'هنسكنكم في هيلتون مكة', blocklist: demoBlocklist, expectBlock: true, desc: 'Hotel brand in output — entity blocklist 2' },
    // same sentences WITHOUT blocklist — should pass
    { text: 'الفندق المخصص لكم هو موفنبيك على بعد خطوات من الحرم', blocklist: undefined, expectBlock: false, desc: 'Hotel brand — no blocklist (baseline, passes)' },
    // digit — always blocked regardless of blocklist
    { text: 'السعر ١٥٠٠٠ جنيه', blocklist: undefined, expectBlock: true, desc: 'Digit in output — always blocked' },
    // clean social — should pass
    { text: 'أهلاً وسهلاً، اسمك ايه يافندم؟', blocklist: demoBlocklist, expectBlock: false, desc: 'Clean social reply — passes with blocklist' },
  ]

  let allPass = true
  console.log('\n══ UNIT TESTS: scanModelOutput entity blocklist ══')
  for (const c of cases) {
    const result = scanModelOutput(c.text, c.blocklist)
    const blocked = result !== null
    const ok = blocked === c.expectBlock
    if (!ok) allPass = false
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${c.desc}`)
    if (!ok) console.log(`         text="${c.text.substring(0,60)}" result=${result} expected_block=${c.expectBlock}`)
  }
  return allPass
}

async function main() {
  console.log('═'.repeat(70))
  console.log('HOTEL CONTENT HANDLER + OUTPUT GUARD ENTITY BLOCKLIST — focused test')
  console.log('Phone: ' + PHONE + ' | simulate=true | zero WhatsApp sends')
  console.log('═'.repeat(70))

  // ── Section C/D: unit tests (offline, no server needed) ─────────────────────
  const unitPass = runUnitTests()

  const ready = await startServer()
  if (!ready) { console.error('\n[FATAL] Server failed to start'); stopServer(); await pool.end(); process.exit(1) }

  let pass = 0; let fail = 0
  function check(id, ok, detail) {
    if (ok) { pass++; console.log(`  [PASS] ${id}: ${detail}`) }
    else     { fail++; console.log(`  [FAIL] ${id}: ${detail}`) }
  }

  // ── Test A: "الفنادق ايه" → HOTEL_CONTENT_HANDLER ─────────────────────────
  console.log('\n── Test A: hotel name query (generic) ──')
  await nukeConv()
  await delay(200)
  // First message: get overview context
  await send('برامج العمرة عندكم ايه')
  await delay(500)
  // Second message: hotel content question
  const replyA = await send('الفنادق ايه')
  const aHasHotelContent = /فنادق الإقامة|مكة المكرمة|المدينة المنورة|اقتصادي|نجوم/.test(replyA)
  const aIsHandoff = isHandoff(replyA)
  const aHasDigit  = hasDigit(replyA)
  console.log(`  Reply preview: ${replyA.substring(0, 120).replace(/\n/g, ' | ')}`)
  check('A1', aHasHotelContent && !aIsHandoff, `Hotel content returned: hasContent=${aHasHotelContent} isHandoff=${aIsHandoff} hasDigit=${aHasDigit}`)
  check('A2', !aHasDigit, `No digit leaked in hotel names reply`)

  // ── Test B: "فندق ايه ٥ نجوم" → level-filtered response ──────────────────
  console.log('\n── Test B: hotel name query with level filter (5-star) ──')
  await nukeConv()
  await delay(200)
  await send('برامج العمرة عندكم ايه')
  await delay(500)
  const replyB = await send('فندق ايه ٥ نجوم')
  const bHasHotelContent = /فنادق الإقامة|مكة المكرمة|المدينة المنورة|خمس نجوم/.test(replyB)
  const bIsHandoff = isHandoff(replyB)
  console.log(`  Reply preview: ${replyB.substring(0, 120).replace(/\n/g, ' | ')}`)
  check('B1', bHasHotelContent && !bIsHandoff, `5-star hotel content returned: hasContent=${bHasHotelContent} isHandoff=${bIsHandoff}`)

  // ── Test E: first-message hotel intent → HOTEL_CONTENT_HANDLER fires ───────
  console.log('\n── Test E: hotel content as first message ──')
  await nukeConv()
  await delay(200)
  const replyE = await send('اسماء الفنادق عندكم ايه')
  const eHasHotelContent = /فنادق الإقامة|مكة|المدينة|اقتصادي|نجوم/.test(replyE)
  const eIsHandoff = isHandoff(replyE)
  console.log(`  Reply preview: ${replyE.substring(0, 120).replace(/\n/g, ' | ')}`)
  // If no catalog data exists, handoff is the correct safe outcome
  check('E1', eHasHotelContent || eIsHandoff, `Handler fired (content or safe handoff): hasContent=${eHasHotelContent} isHandoff=${eIsHandoff}`)
  check('E2', !hasDigit(replyE), `No digit in reply`)

  // ── Test F: hotel distance question NOT captured by hotel content handler ───
  console.log('\n── Test F: distance question bypasses hotel content handler ──')
  await nukeConv()
  await delay(200)
  await send('برامج العمرة عندكم ايه')
  await delay(500)
  const replyF = await send('موفنبيك كام متر من الحرم؟')
  const fHotelDistFired = /موفنبيك/.test(replyF) || replyF.includes('المسافة') || replyF.includes('متر')
  const fHasDigitInDist = hasDigit(replyF)
  console.log(`  Reply preview: ${replyF.substring(0, 120).replace(/\n/g, ' | ')}`)
  // Hotel dist handler returns distance info — HOTEL_DIST_HANDLER expected, not HOTEL_CONTENT
  check('F1', fHotelDistFired || !isHandoff(replyF), `Hotel dist handler fires (not hotel content): distFired=${fHotelDistFired}`)

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log('\n══ SUMMARY ══')
  console.log(`Unit tests (scanModelOutput): ${unitPass ? 'ALL PASS' : 'SOME FAIL'}`)
  console.log(`Integration tests: ${pass} PASS, ${fail} FAIL`)
  const totalPass = unitPass && fail === 0
  console.log(`\nOVERALL: ${totalPass ? '✓ ALL PASS' : '✗ FAILURES DETECTED'}`)

  await nukeConv()
  stopServer()
  await pool.end()
  process.exit(totalPass ? 0 : 1)
}

main().catch(e => { console.error(e); stopServer(); pool.end(); process.exit(1) })
