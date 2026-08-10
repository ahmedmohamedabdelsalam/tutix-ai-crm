/**
 * GATE — MEALS / CHILDREN / BAGGAGE
 *
 * Three questions the client answered differently from how they were first scoped,
 * and the difference is entirely about what data exists:
 *
 *   MEALS    we store two booleans per programme (makkahBreakfast, madinahBreakfast)
 *            and nothing else. So breakfast is answerable per programme, and no
 *            meal count, plan or "all inclusive" claim may ever be made.
 *   CHILDREN child price varies by programme AND transport type, and no child-price
 *            field exists on any OfferingType. Not a gap the agent can fill.
 *   BAGGAGE  the client has no baggage data at all. Any weight would be fabricated,
 *            and a customer packs to that number.
 *
 * The strongest assertion here is the NEGATIVE one: baggage and child replies must
 * contain no digits whatsoever. A fabricated "٢٣ كيلو" is exactly the failure this
 * exists to prevent, and it would look completely plausible.
 *
 * Safety: simulate=true (zero WhatsApp sends), test phone only.
 *   node test/gate/meals-child-baggage-suite.js
 */
'use strict'
const http = require('http')
const { spawn } = require('child_process')
const { Pool } = require('pg')
require('dotenv').config()

const PORT = Number(process.env.GATE_PORT || 3549)
const TOKEN = 'mcbsuite'
const PHONE = '201091656041'
const CO = process.env.DEFAULT_COMPANY_ID
if (!CO) { console.error('FATAL: DEFAULT_COMPANY_ID not set'); process.exit(1) }

const pool = new Pool({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL })
const delay = ms => new Promise(r => setTimeout(r, ms))
const DIGITS = /[0-9٠-٩]/

const post = body => new Promise((res, rej) => {
  const d = JSON.stringify(body)
  const q = http.request({
    hostname: 'localhost', port: PORT, path: '/webhook/test', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d), 'X-Internal-Token': TOKEN },
  }, r2 => { let s = ''; r2.on('data', c => s += c); r2.on('end', () => { try { res(JSON.parse(s)) } catch { res({ raw: s }) } }) })
  q.on('error', rej); q.setTimeout(60000, () => { q.destroy(); rej(new Error('timeout')) })
  q.write(d); q.end()
})

;(async () => {
  const c = await pool.connect()
  let pass = 0, fail = 0, srv = null
  const logs = []
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
  const ask = async (...msgs) => {
    await nuke()
    let last = ''
    for (const m of msgs) { const r = await post({ phone: PHONE, message: m, simulate: true }); last = (r.replies || []).join('\n') }
    return last
  }

  try {
    srv = spawn('node', ['dist/src/main.js'], {
      cwd: 'c:/Users/Computec/tutix-ai-crm', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'production', PORT: String(PORT), TEST_ENDPOINT_TOKEN: TOKEN },
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

    // ── BAGGAGE — nothing may be stated, least of all a weight ────────────────
    console.log('BAGGAGE (no data exists)')
    for (const q of ['الوزن المسموح للشنطة كام؟', 'كام كيلو مسموح في الشنط؟', 'الأمتعة المسموحة ايه؟']) {
      const r = await ask(q)
      const isHandoff = /زميلنا|الفريق|المختص/.test(r)
      t(isHandoff, `"${q}" → routed to a human`, r.slice(0, 120))
      t(!DIGITS.test(r), `"${q}" → states NO number`, r.slice(0, 120))
    }
    t(logs.join('').includes('BAGGAGE_HANDOFF'), 'BAGGAGE_HANDOFF marker logged')

    // ── CHILDREN — price questions go to a human ──────────────────────────────
    console.log('\nCHILDREN (no child-price field exists)')
    for (const q of ['سعر الطفل كام؟', 'الأطفال بيدفعوا كام؟', 'في خصم للأطفال تحت ٦ سنين؟']) {
      const r = await ask(q)
      t(/زميلنا|الفريق|المختص/.test(r), `"${q}" → routed to a human`, r.slice(0, 120))
      t(!DIGITS.test(r), `"${q}" → quotes NO child price`, r.slice(0, 120))
    }
    t(logs.join('').includes('CHILD_PRICE_HANDOFF'), 'CHILD_PRICE_HANDOFF marker logged')

    // A group size mentioning children must NOT be swallowed as a pricing question —
    // that is lead extraction, not a price ask.
    {
      const r = await ask('عايز عمرة', 'أنا وزوجتي وطفلين معايا')
      t(!/CHILD_PRICE/.test(r) && !/أسعار الأطفال/.test(r),
        'a group size mentioning children is NOT treated as a price question', r.slice(0, 120))
    }

    // ── MEALS — answered from the flags, scoped to the programme ──────────────
    console.log('\nMEALS (from makkahBreakfast / madinahBreakfast only)')
    const progs = (await c.query(`
      SELECT o.values AS v FROM "Offering" o JOIN "OfferingType" t ON t.id=o."offeringTypeId"
       WHERE o."companyId"=$1 AND t.name='عمرة' AND o."isActive"=true`, [CO])).rows.map(r => r.v)
    const today = (await c.query(`SELECT to_char(now() AT TIME ZONE 'Africa/Cairo','YYYY-MM-DD') AS d`)).rows[0].d
    const future = progs.filter(p => (p.departureDate ?? '') >= today)
    const withHotel = future.find(p => p.makkahHotel && p.madinahHotel)
    if (!withHotel) throw new Error('no future umrah programme with both hotels to test')

    // Unscoped: programmes differ, so it must ASK rather than pick one.
    {
      const r = await ask('الوجبات مشمولة؟')
      const asks = r.includes('؟')
      const noBlanket = !/كل البرامج شاملة الوجبات/.test(r)
      t(asks, 'unscoped meals question ends with a question', r.slice(0, 140))
      t(noBlanket, 'no blanket "all programmes include meals" claim', r.slice(0, 140))
    }

    // Scoped by hotel: answers from that programme's flags.
    {
      const r = await ask(`فندق ${withHotel.makkahHotel} الإفطار مشمول؟`)
      const mentionsBreakfast = /إفطار|افطار/.test(r)
      t(mentionsBreakfast, 'scoped meals question answers about breakfast', r.slice(0, 160))
      const expectMk = withHotel.makkahBreakfast === true
      // The reply must agree with the stored flag, not with a blanket assumption.
      const saysIncluded = /شامل الإفطار/.test(r)
      const saysNot = /من غير إفطار/.test(r)
      t(saysIncluded || saysNot || r.includes('؟'),
        'reply states a per-hotel breakfast status (or asks to narrow)', r.slice(0, 160))
      if (saysIncluded && !saysNot) {
        t(expectMk, `stated "included" matches stored makkahBreakfast=${withHotel.makkahBreakfast}`, r.slice(0, 160))
      }
      t(r.includes('؟'), 'meals reply ends with a question', r.slice(0, 160))
    }

    // Never asserts a meal COUNT — we store none.
    {
      const r = await ask('كام وجبة في اليوم؟')
      t(!/وجبتين|٣ وجبات|ثلاث وجبات|وجبات يومياً/.test(r),
        'never states a meal count', r.slice(0, 160))
    }
    t(logs.join('').includes('MEALS_HANDLER'), 'MEALS_HANDLER marker logged')
  } catch (e) {
    console.error(`\nFATAL: ${e.message}`)
    fail++
  } finally {
    if (srv) { srv.kill('SIGTERM'); await delay(600) }
    await nuke().catch(() => {})
    c.release(); await pool.end()
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
})()
