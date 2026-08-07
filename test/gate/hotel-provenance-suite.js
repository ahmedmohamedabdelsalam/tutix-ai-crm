/**
 * GATE — UNVERIFIED HOTEL DISTANCES MUST NOT REACH CUSTOMERS
 *
 * A hotel distance is a customer-facing factual claim that arrives through
 * DETERMINISTIC handlers, so it never passes scanModelOutput — whatever is stored
 * goes out verbatim, digits and all. Every distance in this system was migrated
 * from a hardcoded file whose origin nobody recorded: no source comment, no data
 * file, no commit message naming one. "Stored" is not "verified", and a customer
 * chooses a hotel on this number.
 *
 * So a distance is stated only when someone has taken responsibility for it. This
 * suite drives the live CRM and asserts both leak paths are closed:
 *
 *   1. HOTEL_DIST_HANDLER — the verbatim reply
 *   2. findHotelInMessageFromData — the prompt-injection block, which instructs the
 *      model to state its contents directly
 *
 * SAFETY: simulate=true (zero WhatsApp sends), test phone only. It flips one
 * hotel's provenance in the DB, observes, and restores the exact prior value in a
 * finally block.
 *
 *   node test/gate/hotel-provenance-suite.js
 */
'use strict'
const http = require('http')
const { spawn } = require('child_process')
const { Pool } = require('pg')
require('dotenv').config()

const PORT = Number(process.env.GATE_PORT || 3547)
const TOKEN = 'hpsuite'
const PHONE = '201091656041'
const CO = process.env.DEFAULT_COMPANY_ID
if (!CO) { console.error('FATAL: DEFAULT_COMPANY_ID not set'); process.exit(1) }

const pool = new Pool({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL })
const delay = ms => new Promise(r => setTimeout(r, ms))

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
  let pass = 0, fail = 0, srv = null, original = null, cfgId = null
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

  try {
    const cfg = (await c.query(
      `SELECT id, "industryData" AS d FROM "CompanyAIConfig" WHERE "companyId"=$1`, [CO])).rows[0]
    if (!cfg) throw new Error('no CompanyAIConfig')
    cfgId = cfg.id
    original = JSON.parse(JSON.stringify(cfg.d))
    const hotels = cfg.d.hotels || []
    const subject = hotels.find(h => String(h.distance ?? '').trim() && (h.keywords ?? []).length)
    if (!subject) throw new Error('no hotel with a distance and keywords to test with')
    const keyword = subject.keywords[0]
    const ask = `فندق ${keyword} كام متر من الحرم؟`

    console.log(`Subject: ${subject.name}  (keyword "${keyword}")`)
    console.log(`Stored distance: ${subject.distance}`)
    console.log(`Current source: ${subject.distanceSource ?? '(none)'}\n`)

    const setSource = async (src, by) => {
      const next = {
        ...cfg.d,
        hotels: hotels.map(h => h.name === subject.name
          ? { ...h, distanceSource: src, distanceConfirmedBy: by ?? null, distanceConfirmedAt: by ? new Date().toISOString() : null }
          : h),
      }
      await c.query(`UPDATE "CompanyAIConfig" SET "industryData"=$2 WHERE id=$1`, [cfgId, next])
    }

    const boot = async () => {
      srv = spawn('node', ['dist/src/main.js'], {
        cwd: 'c:/Users/Computec/tutix-ai-crm', stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NODE_ENV: 'production', PORT: String(PORT), TEST_ENDPOINT_TOKEN: TOKEN },
      })
      const logs = []
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
      return logs
    }
    const kill = async () => { if (srv) { srv.kill('SIGTERM'); await delay(700); srv = null } }

    // The catalog cache is per-process, so each provenance state gets its own boot.
    // ── 1. UNKNOWN → the number must not appear ──────────────────────────────
    console.log('1. provenance = unknown')
    await setSource('unknown', null)
    let logs = await boot()
    await nuke()
    let r = await post({ phone: PHONE, message: ask, simulate: true })
    let reply = (r.replies || []).join('\n')
    t(!!reply, 'got a reply at all', JSON.stringify(r).slice(0, 200))
    t(!reply.includes(subject.distance), 'stored distance string is NOT sent', reply.slice(0, 160))
    // Any digit run that appears in the stored distance must not appear in the reply —
    // catches a partial leak like "٩٥٠" surviving out of "حوالي ٩٥٠ متر".
    const distDigits = String(subject.distance).match(/[0-9٠-٩]+/g) ?? []
    t(!distDigits.some(d => reply.includes(d)),
      `no digit run from the distance leaks (${distDigits.join(', ') || 'distance has none'})`, reply.slice(0, 160))
    // The rating comes from the same unowned dataset. Refusing the distance while
    // volunteering another unverified measurement would defeat the point.
    if (subject.rating) {
      t(!reply.includes(subject.rating), 'the rating is withheld too — same unowned source', reply.slice(0, 160))
    }
    t(/يأكد|هأكد|الفريق/.test(reply), 'it escalates instead of guessing', reply.slice(0, 160))
    t(reply.includes(subject.name), 'it still names the hotel — refusal is not silence')
    if (subject.location) t(reply.includes(subject.location), 'it still gives what IS known (location)')
    await delay(400)
    t(logs.join('').includes('HOTEL_DIST_UNVERIFIED'), 'HOTEL_DIST_UNVERIFIED logged loudly')
    await kill()

    // ── 2. CONFIRMED → the number is stated ─────────────────────────────────
    console.log('\n2. provenance = client (confirmed)')
    await setSource('client', 'gate@test.local')
    logs = await boot()
    await nuke()
    r = await post({ phone: PHONE, message: ask, simulate: true })
    reply = (r.replies || []).join('\n')
    t(reply.includes(subject.distance), 'confirmed distance IS sent', reply.slice(0, 160))
    t(!logs.join('').includes('HOTEL_DIST_UNVERIFIED'), 'no unverified warning when confirmed')
    await kill()

    // ── 3. the second leak path: the model prompt block ──────────────────────
    console.log('\n3. prompt-injection path (findHotelInMessageFromData)')
    {
      const { findHotelInMessageFromData } = require('../../dist/src/agent/prompts/hajj-umrah-hotels')
      const unknownHotel = { ...subject, distanceSource: 'unknown' }
      const confirmedHotel = { ...subject, distanceSource: 'client' }
      const blockU = findHotelInMessageFromData(ask, [unknownHotel]) ?? ''
      const blockC = findHotelInMessageFromData(ask, [confirmedHotel]) ?? ''
      t(!blockU.includes(subject.distance), 'unconfirmed distance withheld from the MODEL prompt too',
        blockU.slice(0, 200))
      t(/غير مؤكدة/.test(blockU), 'model is told not to state a number', blockU.slice(0, 200))
      t(blockC.includes(subject.distance), 'confirmed distance IS given to the model')
    }
  } catch (e) {
    console.error(`\nFATAL: ${e.message}`)
    fail++
  } finally {
    if (srv) { srv.kill('SIGTERM'); await delay(500) }
    if (cfgId && original) {
      await c.query(`UPDATE "CompanyAIConfig" SET "industryData"=$2 WHERE id=$1`, [cfgId, original]).catch(() => {})
      console.log('\n↩  industryData restored')
    }
    await nuke().catch(() => {})
    c.release(); await pool.end()
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`)
  if (fail > 0) console.log('An unverified distance can reach a customer.')
  process.exit(fail === 0 ? 0 : 1)
})()
