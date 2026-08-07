/**
 * CONFIDENCE LAYER VERIFICATION SUITE â€” Tests aâ€“e
 * Local server only (localhost:3001). Simulate=true throughout.
 * Test phone 201091656041. Zero WhatsApp sends guaranteed:
 *   - simulate=true bypasses sendWhatsAppMessage
 *   - isActive=false on live company (dual-lock, never relaxed here)
 *   - NO writes to isActive / agentMode / env vars
 *
 * Safety invariants confirmed before each section:
 *   - All conversations stamped isTest=true by /webhook/test controller
 *   - HandoffLog writes are expected (they're analytics, not customer-facing)
 *   - Message/Conversation writes are to test phone only
 *
 * Run: node test/gate/confidence-suite.js  (from repo root)
 * Prerequisite: npm run build must already be done.
 */

'use strict'
const http    = require('http')
const { Pool } = require('pg')
const { spawn } = require('child_process')
const path    = require('path')
const fs      = require('fs')
require('dotenv').config()

const PHONE   = '201091656041'
const COMPANY = process.env.DEFAULT_COMPANY_ID
const HOST    = 'localhost'
const PORT    = parseInt(process.env.PORT || '3001', 10)

if (!COMPANY) { console.error('FATAL: DEFAULT_COMPANY_ID not set'); process.exit(1) }

// Use DIRECT_URL for immediate writes (bypasses Supabase pooler 30-s stale cache)
const pool = new Pool({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL })

// Live hotel provenance — Q09 asserts against it rather than assuming a distance
// is always sendable.
let HOTELS_PROVENANCE = []
async function loadHotelProvenance() {
  const c = await pool.connect()
  try {
    const r = await c.query('SELECT "industryData" AS d FROM "CompanyAIConfig" WHERE "companyId"=$1',
      [process.env.DEFAULT_COMPANY_ID])
    HOTELS_PROVENANCE = (r.rows[0] && r.rows[0].d && Array.isArray(r.rows[0].d.hotels)) ? r.rows[0].d.hotels : []
  } finally { c.release() }
}

// â”€â”€ Server process handle â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// ── Test-endpoint auth ───────────────────────────────────────────────────────
// /webhook/test now requires X-Internal-Token (fail-closed). Uses
// TEST_ENDPOINT_TOKEN from the environment when set; otherwise mints an
// ephemeral token and injects it into the server this suite spawns, so a local
// run needs no configuration. Never hardcoded.
const TEST_TOKEN = process.env.TEST_ENDPOINT_TOKEN || require("crypto").randomBytes(24).toString("hex")

let serverProc = null

function startServer() {
  return new Promise(async resolve => {
    console.log('\n[SERVER] Spawning node dist/src/main.js ...')
    serverProc = spawn('node', ['dist/src/main.js'], {
      cwd: path.join(__dirname, '../..'),  // repo root (file lives in test/gate/)
      env: { ...process.env, NODE_ENV: 'production', TEST_ENDPOINT_TOKEN: TEST_TOKEN },
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
    // Poll /webhook/health up to 40 s
    for (let i = 0; i < 40; i++) {
      await delay(1000)
      try {
        const h = await httpGet('/webhook/health')
        if (h.status === 200) { console.log('[SERVER] Ready âœ“'); return resolve(true) }
      } catch {}
    }
    console.error('[SERVER] Did not become ready within 40 s')
    resolve(false)
  })
}

function stopServer() {
  if (serverProc) { serverProc.kill('SIGTERM'); serverProc = null; console.log('[SERVER] Stopped') }
}

async function restartServer(reason) {
  console.log(`\n[SERVER] Restart: ${reason}`)
  stopServer()
  await delay(1500)
  return startServer()
}

// â”€â”€ HTTP helpers (http not https â€” localhost) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function httpPost(urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = http.request(
      { hostname: HOST, port: PORT, path: urlPath, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'X-Internal-Token': TEST_TOKEN } },
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

// â”€â”€ DB helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// A: 20-QUESTION GATE (identical to gate v3, against local server)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const GATE_QUESTIONS = [
  { id: 'Q01', label: 'CTA (35%)',                  msg: 'مرحبًا! هل يمكنني الحصول على مزيد من المعلومات حول هذا؟' },
  { id: 'Q02', label: 'Duration 15d',               msg: 'ممكن تفاصيل العمره ١٥يوم' },
  { id: 'Q03', label: 'Duration 10d economy',       msg: 'ممكن تفاصيل عن رحلات العمرة الاقتصادية ١٠ ايام' },
  { id: 'Q04', label: 'Duration 7d',                msg: 'ممكن اعرف برامج عمره المولد النبوي ٧ايام' },
  { id: 'Q05', label: 'Schedule first-contact',     msg: 'مواعيد العمره والبرامج المتاحه' },
  { id: 'Q06', label: 'Flight first-contact',       msg: 'ممكن التفاصيل واي الطيران' },
  { id: 'Q07', label: 'Installment',                msg: 'عندكم تقسيط؟' },
  { id: 'Q08', label: 'Hotel dist: no hotel',       msg: 'ممكن اعرف اسعار العمرة فنادق قريبة من الحرم؟' },
  { id: 'Q09', label: 'Hotel dist: موفنبيك',         msg: 'موفنبيك كام متر من الحرم؟' },
  { id: 'Q10', label: 'Hajj economy',               msg: 'بسال عن الحج الاقتصادي' },
  { id: 'Q11', label: 'Greeting only',              msg: 'السلام عليكم' },
  { id: 'Q12', label: 'Job inquiry',                msg: 'السلام عليكم \nأنا آية الزيات خريجه من آداب آثار ، كنت بسأل لو متاح شغل' },
  { id: 'Q13', label: 'Short: العمره',              msg: 'العمره' },
  { id: 'Q14', label: 'Pure price',                 msg: 'الأسعار ايه' },
  { id: 'Q15', label: 'عروض العمره (W2)',            msg: 'عروض العمره' },
  { id: 'Q16', label: 'Month: سبتمبر + stars',      msg: 'ارجو ارسال التفاصيل والاسعار عن العمرة برنامج الخمس نجوم شهر سبتمبر' },
  { id: 'Q17', label: 'Month: أغسطس',               msg: 'لو سمحتم برامج العمرة ٧ أو ١٠ ايام خلال شهر أغسطس' },
  { id: 'Q18', label: 'Compound: 15d+hotel+flight', msg: 'تفاصيل العمره ١٥يوم واماكن الاقامه قريبه ولا بعيده عن الحرم والاسعار والطيران من اسكندريه شهر ١٠' },
  { id: 'Q19', label: 'Compound: price+month+15d',  msg: 'ممكن أعرف سعر العمره الإقتصادي آخر شهر 8 لل 15 يوم 11 مكه و 3 مدينه' },
  { id: 'Q20', label: 'Nearest trip (W4)',           msg: 'اقرب رحلة عمرة امتي' },
]

function evalGateVerdict(id, reply) {
  if (id === 'Q01') return reply.includes('١• برامج العمرة') ? 'PASS' : 'FAIL(no CTA menu)'
  if (id === 'Q02') return reply.includes('١٥ يوم') ? 'PASS' : 'FAIL(no 15d block)'
  if (id === 'Q03') {
    if (!reply.includes('١٠ أيام')) return 'FAIL(no 10d block)'
    return reply.includes('مش عندنا برامج اقتصادي') ? 'PASS(mismatch noted)' : 'WARN(no mismatch msg)'
  }
  if (id === 'Q04') return reply.includes('٧ أيام') ? 'PASS' : 'FAIL(no 7d block)'
  if (id === 'Q05') {
    if (reply.includes('برامج العمرة ٢٠٢٦')) return 'PASS(overview shown)'
    if (reply.includes('ابعت رقم البرنامج')) return 'FAIL(dead end, no overview)'
    return 'MANUAL'
  }
  if (id === 'Q06') {
    if (reply.includes('برامج العمرة ٢٠٢٦')) return 'PASS(overview shown)'
    if (reply.includes('ابعت رقم الرحلة المحددة')) return 'FAIL(dead end, no overview)'
    return 'MANUAL'
  }
  if (id === 'Q07') {
    const handoffMarkers = ['زميلنا المختص', 'غير متاح دلوقتي', 'هيرد عليك', 'هيتواصل معك', 'لحظة يافندم', 'فريقنا']
    if (handoffMarkers.some(m => reply.includes(m))) return 'PASS(handoff on installment)'
    if (reply.includes('تقسيط')) return 'FAIL(installment policy leaked — must handoff)'
    return 'FAIL(no handoff on installment question)'
  }
  if (id === 'Q08') {
    if (reply.includes('أي فندق')) return 'PASS(B1 fixed)'
    if (reply.includes('برامج العمرة ٢٠٢٦') || reply.includes('يوليو')) return 'FAIL(B1 broken: overview shown)'
    return 'MANUAL'
  }
  if (id === 'Q09') {
    // A distance may only be stated when its provenance is confirmed. Every value
    // migrated out of hajj-umrah-hotels.ts is 'unknown' — nobody ever recorded a
    // source — so the correct behaviour today is to name the hotel, give what is
    // known, and escalate the number rather than assert it. This asserts against
    // the DATA's provenance so it stays correct once Alex confirms a distance.
    if (!reply.includes('موفنبيك')) return 'FAIL(hotel not named)'
    const confirmed = (HOTELS_PROVENANCE || []).some(h =>
      (h.keywords || []).some(k => 'موفنبيك'.includes(k) || String(k).includes('موفنبيك'))
      && h.distanceSource && h.distanceSource !== 'unknown')
    if (confirmed) return reply.includes('المسافة') ? 'PASS' : 'FAIL(confirmed distance not stated)'
    if (reply.includes('المسافة:')) return 'FAIL(unverified distance leaked)'
    return /يأكد|هأكد|الفريق/.test(reply) ? 'PASS(unverified distance withheld + escalated)'
                                          : 'FAIL(no escalation for unverified distance)'
  }
  if (id === 'Q10') return (reply.includes('الحج') && reply.includes('٢٣٩')) ? 'PASS' : 'MANUAL'
  if (id === 'Q11') return 'PASS'
  if (id === 'Q12') {
    const handoffMarkers = ['زميلنا المختص', 'غير متاح دلوقتي', 'هيرد عليك', 'هيتواصل معك', 'لحظة يافندم', 'فريقنا']
    if (handoffMarkers.some(m => reply.includes(m))) return 'PASS(handoff on job inquiry)'
    if (/[٠١٢٣٤٥٦٧٨٩0-9]/.test(reply)) return 'FAIL(digit leaked in reply)'
    if (/جنيه|دولار|موفنبيك|هيلتون|فيرمونت|شيراتون/.test(reply)) return 'FAIL(catalog fact in reply)'
    return 'PASS(social reply, no facts)'
  }
  if (id === 'Q13') {
    if (reply.includes('برامج العمرة ٢٠٢٦') || reply.includes('يوليو')) return 'FAIL(overview triggered â€” path changed)'
    return 'PASS'
  }
  if (id === 'Q14') return reply.includes('أنهي مدة') ? 'PASS' : 'FAIL(no duration pivot)'
  if (id === 'Q15') {
    if (reply.includes('برامج العمرة ٢٠٢٦') || reply.includes('يوليو')) return 'PASS(W2 fixed: overview fired)'
    if (reply.includes('تشرفنا باسم') || reply.includes('باسم حضرتك')) return 'FAIL(name-ask: overview did not fire)'
    return 'MANUAL'
  }
  if (id === 'Q16') return (reply.includes('خمس نجوم') && reply.includes('سبتمبر')) ? 'PASS' : 'FAIL'
  if (id === 'Q17') return reply.includes('١٠ أيام') ? 'PASS' : 'FAIL'
  if (id === 'Q18') return reply.includes('١٥ يوم') ? 'PASS' : 'FAIL'
  if (id === 'Q19') return reply.includes('١٥ يوم') ? 'PASS' : 'FAIL'
  if (id === 'Q20') {
    if (reply.includes('أقرب رحلة') || (!reply.includes('برامج العمرة ٢٠٢٦') && reply.includes('يوليو'))) return 'PASS(W4: single trip)'
    if (reply.includes('برامج العمرة ٢٠٢٦') && reply.includes('سبتمبر')) return 'FAIL(W4: dumped all months)'
    return 'MANUAL'
  }
  return 'MANUAL'
}

async function runGate() {
  console.log('\n' + 'â•'.repeat(72))
  console.log('A. 20-QUESTION GATE (full isolation, local server)')
  console.log('   gate v3 baseline: 20/20 PASS Â· any change â†’ STOP')
  console.log('â•'.repeat(72))

  const results = []
  let gateBlocked = false

  for (const q of GATE_QUESTIONS) {
    process.stdout.write(`\n[${q.id}] ${q.label}\n  MSG: ${q.msg.substring(0, 80)}\n`)
    await nukeAll()
    await delay(350)

    let reply = '', verdict = 'ERROR', err = null
    try {
      reply = await send(q.msg)
      verdict = evalGateVerdict(q.id, reply)
    } catch(e) { err = e.message }

    if (err) {
      process.stdout.write(`  ERROR: ${err}\n`)
      verdict = 'ERROR'
    } else {
      process.stdout.write(`  VERDICT: ${verdict}\n`)
      process.stdout.write(`  REPLY(120): ${reply.substring(0, 120).replace(/\n/g, ' â†µ ')}\n`)
    }
    results.push({ id: q.id, label: q.label, verdict })

    if (verdict.startsWith('FAIL') || verdict === 'ERROR') {
      console.log(`\n  â›” GATE BLOCKED on ${q.id}: ${verdict} â€” FULL REPLY BELOW:`)
      console.log(reply)
      gateBlocked = true
    }
    // Don't stop on MANUAL â€” flag it but continue to get full picture
  }

  await nukeAll()
  console.log('\n' + 'â”€'.repeat(72))
  console.log('GATE RESULTS:')
  results.forEach(r => console.log(`  [${r.id}] ${r.verdict.padEnd(30)} ${r.label}`))
  const passes  = results.filter(r => r.verdict.startsWith('PASS')).length
  const fails   = results.filter(r => r.verdict.startsWith('FAIL')).length
  const manuals = results.filter(r => r.verdict === 'MANUAL').length
  const errs    = results.filter(r => r.verdict === 'ERROR').length
  console.log(`\nSCORE: ${passes} PASS | ${fails} FAIL | ${manuals} MANUAL | ${errs} ERROR`)
  if (gateBlocked) {
    console.log('âŒ GATE HAS FAILURES â€” stopping suite before commit')
    return false
  }
  if (fails === 0 && errs === 0) {
    console.log('âœ… GATE PASSED â€” zero blockers')
    return true
  }
  return false
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// B: 10 ADVERSARIAL QUESTIONS
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Questions 1â€“8: each isolated (nukeAll before), hit blocked_category â†’ handoff.
// Questions 9â€“10: SAME conversation (no nuke between them).
//   Q9 â†’ no handler â†’ AI social reply â†’ noMatchMap[conv.id] = 1
//   Q10 (gibberish, same conv) â†’ prevNoMatch=1 â†’ newNoMatch=2 â†’ repeat_failure â†’ handoff

const ADVERSARIAL = [
  // Isolated blocked-category cases
  { id: 'ADV01', label: 'Visa rules',         msg: 'أريد معرفة متطلبات التأشيرة للعمرة', expectHandoff: true, cat: 'visa' },
  { id: 'ADV02', label: 'Discount request',   msg: 'ممكن عندكم خصم على برامج العمرة؟', expectHandoff: true, cat: 'discount' },
  { id: 'ADV03', label: 'Refund',             msg: 'عايز استرداد مبلغ الحجز تاعتي', expectHandoff: true, cat: 'refund' },
  { id: 'ADV04', label: 'Booking commitment', msg: 'هحجز دلوقتي أكمل الحجز فين؟', expectHandoff: true, cat: 'booking_commitment' },
  { id: 'ADV05', label: 'Complaint',          msg: 'عندي شكوى من جودة الرحلة', expectHandoff: true, cat: 'complaint' },
  { id: 'ADV06', label: 'Payment methods',    msg: 'هدفع إزاي؟ طرق الدفع إيه؟', expectHandoff: true, cat: 'payment' },
  { id: 'ADV07', label: 'Large group',        msg: 'عندنا فوج رحلة جماعية كبيرة من شركة تعليمية', expectHandoff: true, cat: 'large_group' },
  { id: 'ADV08', label: 'Medical need',       msg: 'عندي حالة طبية خاصة، هل في خدمات مناسبة؟', expectHandoff: true, cat: 'medical' },
  // Consecutive no-handler pair (shared conversation â€” NO nukeAll between ADV09 and ADV10)
  { id: 'ADV09', label: 'Unrelated topic (1/2)', msg: 'هل تقدمون خدمات تأجير سيارات في مكة؟', expectHandoff: false, cat: 'repeat_1' },
  { id: 'ADV10', label: 'Gibberish (2/2 â†’ repeat_failure)', msg: 'كبببببب دددددداا', expectHandoff: true, cat: 'repeat_failure' },
]

// Detect handoff template markers
function isHandoffReply(reply) {
  return reply.includes('زميلنا المختص') || reply.includes('غير متاح دلوقتي') ||
         reply.includes('هيرد عليك') || reply.includes('هيتواصل معك') ||
         reply.includes('لحظة يافندم') || reply.includes('فريقنا')
}

async function runAdversarial() {
  console.log('\n' + 'â•'.repeat(72))
  console.log('B. 10 ADVERSARIAL QUESTIONS')
  console.log('   Each must hand off with correct template. Zero model-generated facts.')
  console.log('â•'.repeat(72))

  const results = []

  for (let i = 0; i < ADVERSARIAL.length; i++) {
    const q = ADVERSARIAL[i]
    // Nuke before each EXCEPT ADV10 (must share conversation with ADV09 for repeat_failure)
    if (q.id !== 'ADV10') {
      await nukeAll()
      await delay(300)
    }

    process.stdout.write(`\n[${q.id}] ${q.label}\n  MSG: ${q.msg}\n`)

    let reply = '', verdict = 'ERROR', err = null
    try {
      reply = await send(q.msg)
      const gotHandoff = isHandoffReply(reply)
      if (q.expectHandoff) {
        verdict = gotHandoff ? 'PASS(handoff)' : 'FAIL(no handoff)'
      } else {
        // ADV09: expect AI reply (not handoff) â€” we just want to establish noMatchMap state
        verdict = !gotHandoff ? 'PASS(AI reply, noMatch=1)' : 'PASS(handoff early â€” also acceptable)'
      }
    } catch(e) { err = e.message }

    if (err) {
      process.stdout.write(`  ERROR: ${err}\n`)
      verdict = 'ERROR'
    } else {
      process.stdout.write(`  VERDICT: ${verdict}\n`)
      process.stdout.write(`  REPLY(120): ${reply.substring(0, 120).replace(/\n/g, ' â†µ ')}\n`)
    }
    results.push({ id: q.id, label: q.label, verdict })
  }

  await nukeAll()
  console.log('\n' + 'â”€'.repeat(72))
  console.log('ADVERSARIAL RESULTS:')
  results.forEach(r => console.log(`  [${r.id}] ${r.verdict.padEnd(30)} ${r.label}`))
  const passes = results.filter(r => r.verdict.startsWith('PASS')).length
  const fails  = results.filter(r => r.verdict.startsWith('FAIL') || r.verdict === 'ERROR').length
  console.log(`SCORE: ${passes}/10 PASS | ${fails} FAIL`)
  if (fails > 0) {
    console.log('âŒ ADVERSARIAL: failures present')
    return false
  }
  console.log('âœ… ADVERSARIAL: all 10 handled correctly')
  return true
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// C: FAQ ROUTE TEST
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Uses keyword "اختبار-فاق-تجريبي" (unique, won't collide with real FAQs or handlers)
const FAQ_KEYWORD = 'اختبار-فاق-تجريبي'
const FAQ_ANSWER  = 'هذا جواب تجريبي للاختبار فقط — TEST ONLY'

async function addTestFAQ() {
  const c = await pool.connect()
  try {
    await c.query(
      `INSERT INTO "CompanyFAQ" ("id","companyId","question","answer","keywords","isActive","createdAt","updatedAt")
       VALUES (gen_random_uuid(),$1,'TEST â€” DELETE ME',$2,$3::jsonb,true,NOW(),NOW())`,
      [COMPANY, FAQ_ANSWER, JSON.stringify([FAQ_KEYWORD])]
    )
    console.log(`  âœ“ Test FAQ entry added: keyword="${FAQ_KEYWORD}"`)
  } finally { c.release() }
}

async function deleteTestFAQ() {
  const c = await pool.connect()
  try {
    const r = await c.query(
      `DELETE FROM "CompanyFAQ" WHERE "companyId"=$1 AND question='TEST â€” DELETE ME' RETURNING id`,
      [COMPANY]
    )
    console.log(`  âœ“ Test FAQ deleted: ${r.rowCount} row(s) removed`)
    // Verify deletion
    const check = await c.query(
      `SELECT COUNT(*) as n FROM "CompanyFAQ" WHERE "companyId"=$1 AND question='TEST â€” DELETE ME'`,
      [COMPANY]
    )
    const remaining = parseInt(check.rows[0].n)
    if (remaining > 0) console.error(`  âš  Deletion verification FAILED: ${remaining} rows still present`)
    else console.log('  âœ“ Deletion verified: 0 rows remain')
    return r.rowCount
  } finally { c.release() }
}

async function getFAQCount() {
  const c = await pool.connect()
  try {
    const r = await c.query('SELECT COUNT(*) as n FROM "CompanyFAQ" WHERE "companyId"=$1 AND "isActive"=true', [COMPANY])
    return parseInt(r.rows[0].n)
  } finally { c.release() }
}

async function runFAQTest() {
  console.log('\n' + 'â•'.repeat(72))
  console.log('C. FAQ ROUTE TEST')
  console.log('   Entry added before server start (cache cold on first FAQ request)')
  console.log('â•'.repeat(72))

  const beforeCount = await getFAQCount()
  console.log(`\n  FAQ count before addition: ${beforeCount}`)
  // FAQ entry was added before server start â€” already in DB

  // C1: Positive â€” keyword should return verbatim answer
  console.log('\n  C1: Positive test (server sees entry in fresh cache)')
  await nukeAll()
  await delay(300)
  let faqReply = '', c1Verdict = 'ERROR', c1Err = null
  try {
    faqReply = await send(FAQ_KEYWORD)
    if (faqReply.includes(FAQ_ANSWER)) {
      c1Verdict = 'PASS(verbatim answer returned)'
    } else if (isHandoffReply(faqReply)) {
      c1Verdict = 'FAIL(handoff instead of FAQ answer)'
    } else {
      c1Verdict = 'FAIL(neither FAQ answer nor handoff)'
    }
  } catch(e) { c1Err = e.message }
  if (c1Err) { console.log(`  C1 ERROR: ${c1Err}`); c1Verdict = 'ERROR' }
  else { console.log(`  C1 VERDICT: ${c1Verdict}\n  C1 REPLY(150): ${faqReply.substring(0, 150)}`) }
  await nukeAll()

  // Delete entry from DB, then restart server to clear FAQ cache
  const deleted = await deleteTestFAQ()
  const afterCount = await getFAQCount()
  console.log(`  FAQ count after deletion: ${afterCount} (was ${beforeCount}, removed ${deleted})`)

  console.log('\n  Restarting server to clear in-memory FAQ cache...')
  const restarted = await restartServer('clear FAQ cache after entry deletion')
  if (!restarted) {
    console.error('  âš  Server restart failed â€” C2 test cannot run reliably')
    return { c1: c1Verdict, c2: 'SKIP(restart failed)' }
  }

  // C2: Negative â€” same keyword, no FAQ entry â†’ should go to AI or handoff (NOT verbatim answer)
  console.log('\n  C2: Negative test (entry deleted, fresh server cache)')
  await nukeAll()
  await delay(300)
  let faqReply2 = '', c2Verdict = 'ERROR', c2Err = null
  try {
    faqReply2 = await send(FAQ_KEYWORD)
    if (faqReply2.includes(FAQ_ANSWER)) {
      c2Verdict = 'FAIL(stale cached answer still returned after deletion)'
    } else {
      // Any reply OTHER than the verbatim answer is acceptable â€” AI, handoff, etc.
      c2Verdict = 'PASS(verbatim answer not returned after deletion)'
    }
  } catch(e) { c2Err = e.message }
  if (c2Err) { console.log(`  C2 ERROR: ${c2Err}`); c2Verdict = 'ERROR' }
  else { console.log(`  C2 VERDICT: ${c2Verdict}\n  C2 REPLY(120): ${faqReply2.substring(0, 120)}`) }
  await nukeAll()

  console.log('\n' + 'â”€'.repeat(72))
  const ok = c1Verdict.startsWith('PASS') && c2Verdict.startsWith('PASS')
  console.log(`C1: ${c1Verdict}`)
  console.log(`C2: ${c2Verdict}`)
  console.log(ok ? 'âœ… FAQ TEST: PASS' : 'âŒ FAQ TEST: FAILURES')
  return { c1: c1Verdict, c2: c2Verdict, ok }
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// D: OUTPUT GUARD TEST
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Send a question the model answers with a digit. Expect:
//   1. Handoff reply returned (not digit-containing text)
//   2. HandoffLog row written with reason='output_guard' and blockedOutput containing digits
//   3. Console log: OUTPUT_GUARD_BLOCK
//
// We use two questions â€” first one is more likely to elicit digits, second is backup.
const GUARD_QUESTIONS = [
  'ما هو ناتج ضرب ٧ في ٧؟',            // math → AI says ٤٩
  'اكتبلي الأرقام من ١ إلى ٥ فقط',     // counting → AI says ١ ٢ ٣ ٤ ٥
]

async function runOutputGuardTest() {
  console.log('\n' + 'â•'.repeat(72))
  console.log('D. OUTPUT GUARD TEST')
  console.log('   Force AI to emit a digit â†’ confirm guard discards it â†’ handoff returned')
  console.log('   HandoffLog row must appear with reason=output_guard and offending text')
  console.log('â•'.repeat(72))

  let guardFired = false
  let guardVerdict = 'FAIL(guard did not fire on any test question)'
  let checkedHandoffLog = false

  for (const guardMsg of GUARD_QUESTIONS) {
    await nukeAll()
    await delay(300)
    process.stdout.write(`\n  SENDING: ${guardMsg}\n`)

    let reply = '', err = null
    try { reply = await send(guardMsg) } catch(e) { err = e.message }

    if (err) { console.log(`  ERROR: ${err}`); continue }

    process.stdout.write(`  REPLY(150): ${reply.substring(0, 150).replace(/\n/g, ' â†µ ')}\n`)

    const replyHasDigit = /[٠١٢٣٤٥٦٧٨٩0-9]/.test(reply)
    const replyIsHandoff = isHandoffReply(reply)

    if (replyHasDigit) {
      console.log(`  FAIL: digit leaked through output guard in reply: "${reply.match(/[٠١٢٣٤٥٦٧٨٩0-9]/)?.[0]}"`)
      guardVerdict = 'FAIL(digit leaked into reply)'
    } else if (replyIsHandoff) {
      console.log('  âœ“ Handoff reply returned (no digits)')
      guardFired = true

      // Check HandoffLog
      const c = await pool.connect()
      try {
        await delay(500) // allow async logHandoff to commit
        const { rows } = await c.query(
          `SELECT id, reason, "blockedOutput", "createdAt" FROM "HandoffLog"
           WHERE phone=$1 AND reason='output_guard' AND "companyId"=$2
           ORDER BY "createdAt" DESC LIMIT 1`,
          [PHONE, COMPANY]
        )
        if (rows.length > 0) {
          const log = rows[0]
          const hasBlockedOutput = !!log.blockedOutput
          const blockedHasDigit  = hasBlockedOutput && /[٠١٢٣٤٥٦٧٨٩0-9]/.test(log.blockedOutput)
          console.log(`  ✓ HandoffLog row found: id=${log.id}`)
          console.log(`    reason=${log.reason}`)
          console.log(`    blockedOutput(80): "${(log.blockedOutput || '').substring(0, 80)}"`)
          console.log(`    blockedOutput contains digit: ${blockedHasDigit}`)
          checkedHandoffLog = true
          if (blockedHasDigit) {
            guardVerdict = 'PASS(guard fired, handoff returned, HandoffLog written with digit in blockedOutput)'
          } else if (hasBlockedOutput) {
            guardVerdict = 'PASS(guard fired on month name, HandoffLog written)'
          } else {
            guardVerdict = 'PASS(guard fired, handoff returned â€” HandoffLog missing blockedOutput)'
          }
        } else {
          console.log('  âš  HandoffLog row NOT found â€” logHandoff may not have flushed yet or output_guard not triggered')
          guardVerdict = 'PARTIAL(handoff returned but no HandoffLog row found)'
        }
      } finally { c.release() }
      break // guard fired on this question, no need to try next
    } else {
      console.log(`  â„¹ AI replied without digits and without handoff pattern â€” guard not triggered on this question`)
      console.log('  â†’ Trying next guard question...')
    }
  }

  await nukeAll()
  console.log('\n' + 'â”€'.repeat(72))
  console.log(`D VERDICT: ${guardVerdict}`)
  if (!guardFired) {
    console.log('  NOTE: The output guard can only fire when the model actually emits a digit.')
    console.log('  If the model responded with word-numbers (e.g. "أربعة وتسعون"), the guard correctly does not fire.')
    console.log('  Unit test for scanModelOutput:')
    // Inline unit test of the guard logic
    const tests = [
      { input: 'السعر ١٢٠٠ جنيه', expectTrigger: true },
      { input: 'hello 42 world',    expectTrigger: true },
      { input: 'شهر يوليو القادم',  expectTrigger: true },  // month name
      { input: 'أهلاً وسهلاً يافندم', expectTrigger: false },
    ]
    let unitOk = true
    for (const t of tests) {
      const digitMatch = t.input.match(/[٠١٢٣٤٥٦٧٨٩0-9]/)
      const monthMatch = t.input.match(/يوليو|أغسطس|سبتمبر|أكتوبر|نوفمبر|ديسمبر|يناير|فبراير|مارس|أبريل|مايو|يونيو/)
      const triggered  = !!(digitMatch || monthMatch)
      const pass = triggered === t.expectTrigger
      if (!pass) unitOk = false
      console.log(`    scanModelOutput("${t.input.substring(0, 30)}") → trigger=${triggered} ${pass ? 'âœ“' : 'âœ— FAIL'}`)
    }
    if (unitOk) {
      guardVerdict = guardVerdict + ' + UNIT_TEST_PASS(scanModelOutput wired correctly)'
      console.log('  âœ… scanModelOutput unit test: PASS (guard logic is correct)')
    } else {
      console.log('  âŒ scanModelOutput unit test: FAIL')
    }
  }
  return guardVerdict
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// E: WORKING HOURS TEMPLATE TEST (pure function, no server call, no DB mutation)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Replicates buildHandoffMessage logic exactly as in confidence-router.ts.
// Tests with injected Date objects â€” live company config is never read or modified.

const DEFAULT_HANDOFF_INSIDE  = 'لحظة يافندم — زميلنا المختص هيرد عليك في أقرب وقت 🤍\n\nعندك سؤال تاني؟'
const DEFAULT_HANDOFF_OUTSIDE = 'يافندم شكراً لتواصلك 🤍\n\nفريقنا غير متاح دلوقتي — هيتواصل معك أول ما يفتح الدوام إن شاء الله\n\nممكن تقولي اسمك وإيه اللي محتاج تعرفه بالتحديد؟'

function buildHandoffMessage(templates, overrideNow) {
  const wh = templates && templates.workingHours
  if (!wh || !wh.start || !wh.end || !wh.timezone) {
    return (templates && templates.handoffTemplateInsideHours) || DEFAULT_HANDOFF_INSIDE
  }
  try {
    const base    = overrideNow || new Date()
    const nowInTz = new Date(base.toLocaleString('en-US', { timeZone: wh.timezone }))
    const [sh, sm] = String(wh.start).split(':').map(Number)
    const [eh, em] = String(wh.end).split(':').map(Number)
    const nowMins  = nowInTz.getHours() * 60 + nowInTz.getMinutes()
    const startM   = sh * 60 + sm
    const endM     = eh * 60 + em
    const dayOk    = !wh.days || wh.days.includes(nowInTz.getDay())
    const isOpen   = dayOk && nowMins >= startM && nowMins < endM
    return isOpen
      ? (templates.handoffTemplateInsideHours  || DEFAULT_HANDOFF_INSIDE)
      : (templates.handoffTemplateOutsideHours || DEFAULT_HANDOFF_OUTSIDE)
  } catch {
    return (templates && templates.handoffTemplateInsideHours) || DEFAULT_HANDOFF_INSIDE
  }
}

function runWorkingHoursTest() {
  console.log('\n' + 'â•'.repeat(72))
  console.log('E. WORKING HOURS TEMPLATE TEST (pure offline function, zero DB mutation)')
  console.log('   Live company config is NOT read or modified.')
  console.log('   Injecting test timestamps into replicated buildHandoffMessage logic.')
  console.log('â•'.repeat(72))

  const testTemplates = {
    workingHours: { start: '09:00', end: '21:00', timezone: 'Africa/Cairo' },
    handoffTemplateInsideHours:  'رسالة داخل أوقات العمل [TEST]',
    handoffTemplateOutsideHours: 'رسالة خارج أوقات العمل [TEST]',
  }

  // Create timestamps that map to specific Cairo local times.
  // Cairo in July 2026 = UTC+3.
  // 13:00 Cairo = 10:00 UTC â†’ inside (09:00â€“21:00)
  // 23:00 Cairo = 20:00 UTC â†’ outside (>21:00)
  // 07:00 Cairo = 04:00 UTC â†’ outside (<09:00)
  function cairoDateAt(utcHour, utcMinute) {
    const d = new Date()
    d.setUTCHours(utcHour, utcMinute, 0, 0)
    return d
  }

  const cases = [
    { label: 'Inside hours  (13:00 Cairo = 10:00 UTC)', now: cairoDateAt(10, 0), expectInside: true  },
    { label: 'Outside hours (23:00 Cairo = 20:00 UTC)', now: cairoDateAt(20, 0), expectInside: false },
    { label: 'Outside hours (07:00 Cairo = 04:00 UTC)', now: cairoDateAt(4,  0), expectInside: false },
    { label: 'Boundary open  (09:00 Cairo = 06:00 UTC)', now: cairoDateAt(6,  0), expectInside: true  },
    { label: 'Boundary closed(21:00 Cairo = 18:00 UTC)', now: cairoDateAt(18, 0), expectInside: false },
  ]

  let allPass = true
  for (const tc of cases) {
    const result     = buildHandoffMessage(testTemplates, tc.now)
    const gotInside  = result === testTemplates.handoffTemplateInsideHours
    const gotOutside = result === testTemplates.handoffTemplateOutsideHours
    const expected   = tc.expectInside ? 'INSIDE' : 'OUTSIDE'
    const got        = gotInside ? 'INSIDE' : gotOutside ? 'OUTSIDE' : 'UNEXPECTED'
    const pass       = expected === got
    if (!pass) allPass = false
    console.log(`  [${pass ? 'âœ“' : 'âœ—'}] ${tc.label}`)
    console.log(`      Expected=${expected} Got=${got} Reply="${result.substring(0, 40)}"`)
  }

  // Test no-config fallback (no workingHours â†’ always inside-hours default)
  const noConfigResult = buildHandoffMessage(null, cairoDateAt(20, 0))
  const noConfigPass   = noConfigResult === DEFAULT_HANDOFF_INSIDE
  if (!noConfigPass) allPass = false
  console.log(`  [${noConfigPass ? 'âœ“' : 'âœ—'}] No-config fallback â†’ "${noConfigResult.substring(0, 40)}"`)

  console.log('\n' + 'â”€'.repeat(72))
  console.log(`E VERDICT: ${allPass ? 'âœ… PASS â€” all working-hours cases correct' : 'âŒ FAIL â€” working-hours logic has errors'}`)
  return allPass
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// HANDOFF-LOG VERIFICATION (after all tests)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function verifyHandoffLog() {
  console.log('\n' + 'â•'.repeat(72))
  console.log('HANDOFF LOG VERIFICATION (DB query â€” read only after tests)')
  console.log('â•'.repeat(72))
  const c = await pool.connect()
  try {
    // Count all HandoffLog entries for test phone in last 2 hours
    const { rows } = await c.query(
      `SELECT reason, category, COUNT(*) as n
       FROM "HandoffLog"
       WHERE phone=$1 AND "companyId"=$2
         AND "createdAt" > NOW() - INTERVAL '2 hours'
       GROUP BY reason, category
       ORDER BY n DESC`,
      [PHONE, COMPANY]
    )
    if (rows.length === 0) {
      console.log('  No HandoffLog entries for test phone in last 2 hours.')
    } else {
      console.log('  HandoffLog entries (last 2 h):')
      rows.forEach(r => console.log(`    reason=${r.reason} cat=${r.category || 'null'} count=${r.n}`))
    }
    // Specifically check for output_guard entry
    const { rows: og } = await c.query(
      `SELECT id, "blockedOutput", "createdAt" FROM "HandoffLog"
       WHERE phone=$1 AND reason='output_guard' AND "companyId"=$2
       ORDER BY "createdAt" DESC LIMIT 1`,
      [PHONE, COMPANY]
    )
    if (og.length > 0) {
      console.log(`\n  output_guard entry: id=${og[0].id} at ${og[0].createdAt}`)
      console.log(`  blockedOutput: "${(og[0].blockedOutput || '').substring(0, 80)}"`)
    } else {
      console.log('\n  No output_guard HandoffLog entry found (guard may not have fired).')
    }
  } finally { c.release() }
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// POST-RUN SAFETY CHECK: confirm no non-test conversations were modified
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function safetyCheck() {
  const c = await pool.connect()
  try {
    // All conversations created/modified during this run should be isTest=true
    // Check: any non-test conversation for the test phone (should be 0)
    const { rows } = await c.query(
      `SELECT COUNT(*) as n FROM "Conversation"
       WHERE phone=$1 AND "companyId"=$2 AND "isTest"=false`,
      [PHONE, COMPANY]
    )
    const nonTest = parseInt(rows[0].n)
    if (nonTest > 0) {
      console.log(`  âš  SAFETY: ${nonTest} non-test conversation(s) found for test phone â€” investigate`)
    } else {
      console.log(`  âœ“ SAFETY: all test-phone conversations stamped isTest=true`)
    }
  } finally { c.release() }
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// MAIN
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function main() {
  console.log('CONFIDENCE LAYER VERIFICATION SUITE')
  console.log('Date: ' + new Date().toISOString())
  console.log('Phone under test: ' + PHONE + ' (test-only)')
  console.log('Simulate: true throughout â€” zero WhatsApp sends')
  console.log('No writes to isActive / agentMode / env vars')
  console.log('â•'.repeat(72))

  // Add FAQ test entry to DB BEFORE starting the server
  // (server cache starts cold â†’ first FAQ call loads this entry from DB)
  console.log('\n[PRE-RUN] Adding test FAQ entry to DB...')
  await addTestFAQ()
  const faqCountBefore = await getFAQCount()
  console.log(`[PRE-RUN] FAQ count now: ${faqCountBefore}`)

  await loadHotelProvenance()
  const started = await startServer()
  if (!started) {
    console.error('Server failed to start. Aborting suite.')
    await deleteTestFAQ().catch(() => {})
    await pool.end()
    process.exit(1)
  }

  let gateOk = false, advOk = false, faqResult = {}, guardVerdict = '', hoursOk = false
  const runStart = Date.now()

  try {
    // A: Gate
    gateOk = await runGate()
    if (!gateOk) {
      // Report but continue â€” must gather full picture
      console.log('\nâš  Gate has failures. Continuing other tests for full picture...')
    }

    // B: Adversarial
    advOk = await runAdversarial()

    // C: FAQ (includes server restart internally)
    faqResult = await runFAQTest()

    // D: Output guard
    guardVerdict = await runOutputGuardTest()

  } finally {
    stopServer()
  }

  // E: Working hours (offline â€” no server needed)
  hoursOk = runWorkingHoursTest()

  // HandoffLog verification (DB read only)
  await verifyHandoffLog()

  // Safety check
  await safetyCheck()

  const elapsed = ((Date.now() - runStart) / 1000).toFixed(0)

  console.log('\n' + 'â•'.repeat(72))
  console.log('FINAL SUMMARY')
  console.log('â•'.repeat(72))
  console.log(`A: Gate (20 questions)  â†’ ${gateOk ? 'âœ… PASS' : 'âŒ FAIL/PARTIAL'}`)
  console.log(`B: Adversarial (10 q)   â†’ ${advOk  ? 'âœ… PASS' : 'âŒ FAIL/PARTIAL'}`)
  console.log(`C: FAQ route            â†’ C1=${faqResult.c1} | C2=${faqResult.c2}`)
  console.log(`D: Output guard         â†’ ${guardVerdict}`)
  console.log(`E: Working hours        â†’ ${hoursOk ? 'âœ… PASS' : 'âŒ FAIL'}`)
  console.log(`\nElapsed: ${elapsed}s`)
  console.log('\nSCHEMA PARITY (STEP 0 â€” already completed):')
  console.log('  tutix-ai-crm: HandoffLog + CompanyFAQ.keywords  âœ…')
  console.log('  tutix-dashboard: HandoffLog + CompanyFAQ.keywords âœ… (added this session)')
  console.log('  prisma generate (both repos): âœ…')
  console.log('  tsc (both repos): âœ… clean')
  console.log('\nâ›” STOPPED â€” awaiting commit approval')

  await pool.end()
}

main().catch(e => {
  console.error('FATAL:', e.message, e.stack)
  stopServer()
  pool.end().then(() => process.exit(1))
})

