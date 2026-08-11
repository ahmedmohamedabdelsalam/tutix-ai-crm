/**
 * GATE — AN IMAGE MAY NEVER OUTLIVE THE PRICE PRINTED ON IT  (Stage 2)
 *
 * Every other guard in this project reads TEXT. scanModelOutput checks digits,
 * months and hotel names against live data; against a JPEG it is completely blind.
 * So the only thing standing between a customer and a wrong price in picture form is
 * the fingerprint comparison this suite exists to hold — and a picture is more
 * convincing than a message and can be screenshotted into a dispute.
 *
 * Three things must stay true, and the third is the one that will rot first:
 *
 *   A. a FRESH image attaches                     — the feature works at all
 *   B. a STALE image is refused, TEXT STILL SENT  — fail-closed, never fail-silent
 *   C. CHUNK MODE never attaches                  — three programmes, three prices,
 *                                                   one picture can't caption them
 *
 * B is asserted in both halves deliberately. "No image" alone would also be true if
 * the reply had failed entirely, so the text is asserted present in the same breath;
 * otherwise a total outage would read as a passing safety test.
 *
 * SAFETY: simulate=true — descriptors are returned, nothing is uploaded and nothing
 * reaches Meta. Test phone only. The seeded descriptor is written to ONE offering's
 * `images` value and restored in a finally block; no offering is ever deleted or
 * deactivated, and no price or content field is touched.
 *
 *   npm run build && node test/gate/programme-images-suite.js
 */
'use strict'
const http = require('http')
const path = require('path')
const crypto = require('crypto')
const { Pool } = require('pg')
const { spawn } = require('child_process')
require('dotenv').config()

const PHONE   = '201091656041'
const COMPANY = process.env.DEFAULT_COMPANY_ID
const PORT    = parseInt(process.env.PORT || '3001', 10)
if (!COMPANY) { console.error('FATAL: DEFAULT_COMPANY_ID not set'); process.exit(1) }

const pool = new Pool({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL })
const TEST_TOKEN = process.env.TEST_ENDPOINT_TOKEN || crypto.randomBytes(24).toString('hex')
// The cache-bust endpoint authenticates against a DIFFERENT env var and fails closed
// when it is unset. Both are pinned into the child's env below, because a silently
// refused bust would leave the seeded image invisible and read as "the feature
// doesn't work" — which is exactly the false signal that cost a run here.
const CACHE_TOKEN = process.env.INTERNAL_CACHE_TOKEN || crypto.randomBytes(24).toString('hex')
const delay = ms => new Promise(r => setTimeout(r, ms))
let serverProc = null, logBuf = []

// The built artifact, never the source — gate suites must assert against the code
// that actually runs. Asserting src/ after forgetting to build tests nothing.
const IMG = require('../../dist/src/whatsapp/programme-images')
const SHAPE = require('../../dist/src/whatsapp/reply-shape')

let pass = 0, fail = 0
const t = (ok, label, detail) => {
  if (ok) { console.log(`  ✅ ${label}`); pass++ }
  else { console.log(`  ❌ ${label}${detail ? `\n     ${detail}` : ''}`); fail++ }
}
const skip = why => console.log(`  ⏭  ${why}`)

function httpPost(p, body, token) {
  return new Promise((resolve, reject) => {
    const d = JSON.stringify(body)
    const r = http.request({ hostname: 'localhost', port: PORT, path: p, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d), 'X-Internal-Token': token || TEST_TOKEN } },
      res => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)) } catch { resolve(b) } }) })
    r.on('error', reject); r.setTimeout(60000, () => { r.destroy(); reject(new Error('timeout')) })
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
    env: { ...process.env, NODE_ENV: 'production', TEST_ENDPOINT_TOKEN: TEST_TOKEN, INTERNAL_CACHE_TOKEN: CACHE_TOKEN },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  serverProc.stdout.on('data', d => logBuf.push(d.toString()))
  serverProc.stderr.on('data', d => logBuf.push(d.toString()))
  for (let i = 0; i < 40; i++) { await delay(1000); try { if (await httpGet('/webhook/health') === 200) return true } catch {} }
  return false
}
const stopServer = () => { if (serverProc) { serverProc.kill('SIGTERM'); serverProc = null } }

const send = m => httpPost('/webhook/test', { phone: PHONE, message: m, simulate: true })
const bust = async () => {
  const r = await httpPost('/webhook/internal/cache-bust', { companyId: COMPANY }, CACHE_TOKEN)
  // A refused bust means every later assertion reads a stale catalog. Fail here, at
  // the cause, rather than three assertions later at the symptom.
  if (!r || r.ok !== true) throw new Error(`cache-bust refused: ${JSON.stringify(r)}`)
  return r
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

/**
 * The price fingerprint, reimplemented here from its documented algorithm — the
 * THIRD independent statement of it (dashboard writes, CRM enforces, this asserts).
 * Importing the module's own copy would make the test agree with itself no matter
 * what the algorithm became; restating it means a silent change fails here.
 */
function fingerprint(values, fieldDefs) {
  const keys = fieldDefs.filter(f => f.role && f.role.startsWith('price')).map(f => f.key).sort()
  if (!keys.length) return ''
  const canonical = keys.map(k => [k, values[k] == null ? '' : String(values[k]).trim()])
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

const descriptor = fp => ({
  url: 'https://example.invalid/gate-programme-image.jpg',
  path: 'gate/programme-image.jpg',
  mime: 'image/jpeg',
  bytes: 12345,
  checksum: 'gate' + 'f'.repeat(60),
  priceBearing: true,
  priceFingerprint: fp,
})

;(async () => {
  const c = await pool.connect()
  let target = null, originalValues = null, imageKey = null

  try {
    // ══ PART 1 — the decision layer, exhaustively ═══════════════════════════════
    // Pure functions, no server, no DB: every branch of "may I attach this?" stated
    // once so a future refactor cannot quietly widen the sendable set.
    console.log('1. the decision layer (dist/programme-images)')
    {
      const FP = 'a'.repeat(64)
      const fresh = { name: 'P', priceFingerprintNow: FP, images: [descriptor(FP)] }
      const stale = { name: 'P', priceFingerprintNow: FP, images: [descriptor('b'.repeat(64))] }

      t(IMG.attachmentFor(fresh, 'اسم البرنامج — ٥٠٠٠٠ جنيه', 'T').length === 1,
        'a FRESH image attaches')
      t(IMG.attachmentFor(stale, 'اسم البرنامج', 'T').length === 0,
        'a STALE image is refused')
      t(IMG.attachmentFor({ ...fresh, priceFingerprintNow: '' }, 'x', 'T').length === 0,
        'no CURRENT fingerprint to compare against → refused (doubt loses)')
      t(IMG.attachmentFor({ name: 'P', priceFingerprintNow: FP, images: [descriptor('')] }, 'x', 'T').length === 0,
        'a descriptor with NO stored fingerprint → refused')
      t(IMG.attachmentFor({ name: 'P', priceFingerprintNow: FP, images: [] }, 'x', 'T').length === 0,
        'no descriptor at all → no image, no crash')
      t(IMG.attachmentFor(undefined, 'x', 'T').length === 0,
        'a missing programme → no image, no crash')
      t(IMG.attachmentFor({ name: 'P', priceFingerprintNow: FP, images: [{ nonsense: true }] }, 'x', 'T').length === 0,
        'a malformed descriptor → refused, never sent as-is')

      // Not price-bearing: nothing on it can go stale, so staleness cannot block it.
      const generic = { ...descriptor('mismatch'), priceBearing: false }
      t(IMG.attachmentFor({ name: 'P', priceFingerprintNow: FP, images: [generic] }, 'x', 'T').length === 1,
        'a NON-price-bearing image attaches even when the price moved')

      // The multi-programme rule — chunk mode's sibling. One picture cannot honestly
      // caption a reply that quotes several different prices.
      t(IMG.resolveSingleProgramme({ progs: [fresh] }) !== null, 'a one-programme trip resolves')
      t(IMG.resolveSingleProgramme({ progs: [fresh, fresh] }) === null,
        'a MULTI-programme trip resolves to null → no image')
      t(IMG.attachmentFor({ progs: [fresh, fresh] }, 'x', 'T').length === 0,
        'a multi-programme trip attaches nothing')

      // The caption rides on the image and can never be regenerated, so it must not
      // carry a number. Everything numeric stays in the text below it.
      // A duration in the NAME ("١٤ يوم") is fine — it cannot go stale. What must
      // never survive into the caption is a figure of money.
      const cap = IMG.attachmentFor(fresh, 'برنامج أكتوبر ١٤ يوم — ٥٠٠٠٠ جنيه\nتفاصيل', 'T')[0].caption
      t(!cap.includes('٥٠٠٠٠') && !cap.includes('جنيه'), `the caption carries NO price — "${cap}"`)
      t(cap === 'برنامج أكتوبر ١٤ يوم', 'the caption is the NAME only, cut at the price clause')
      t(IMG.attachmentFor(fresh, '', 'T')[0].caption.length >= 0, 'an empty detail does not crash the caption')
    }

    // ══ PART 2 — the fingerprint algorithm, stated independently ════════════════
    console.log('\n2. the price fingerprint agrees with its documented algorithm')
    {
      const defs = [
        { key: 'q', role: 'price',        inputType: 'number' },
        { key: 'd', role: 'price-double', inputType: 'number' },
        { key: 'n', role: 'title',        inputType: 'text' },
      ]
      const v = { q: 50000, d: 62000, n: 'اسم' }
      t(IMG.priceFingerprint(v, defs) === fingerprint(v, defs),
        'module and suite compute the SAME fingerprint')
      t(IMG.priceFingerprint(v, defs) !== IMG.priceFingerprint({ ...v, q: 50001 }, defs),
        'changing a price CHANGES the fingerprint')
      t(IMG.priceFingerprint(v, defs) === IMG.priceFingerprint({ ...v, n: 'اسم آخر' }, defs),
        'changing a NON-price field leaves it alone')
      t(IMG.priceFingerprint({}, [{ key: 'n', role: 'title' }]) === '',
        'no price fields → empty fingerprint → nothing can be sent against it')
    }

    // ══ PART 3 — the reply shape ════════════════════════════════════════════════
    console.log('\n3. the widened reply shape stays backward-compatible')
    {
      t(SHAPE.normalizeResult('hi').replies.length === 1, 'a bare string still means one reply')
      t(SHAPE.normalizeResult('hi').images.length === 0, 'a bare string carries no image')
      t(SHAPE.normalizeResult(['a', 'b']).replies.length === 2, 'an array still means two replies')
      t(SHAPE.normalizeResult(null).replies.length === 0, 'null means no reply, not a crash')
      t(SHAPE.normalizeResult('').replies.length === 0, 'an empty string is not a reply')
      const rich = SHAPE.normalizeResult({ replies: ['a'], images: [{ url: 'u', mime: 'm', checksum: 'c', caption: 'x' }] })
      t(rich.replies.length === 1 && rich.images.length === 1, 'a rich reply carries both halves')
    }

    // ══ PART 4 — end to end, through the server that actually runs ══════════════
    console.log('\n4. end to end')
    if (!await startServer()) { console.error('FATAL: server did not start'); fail++; throw new Error('no server') }
    await nuke()

    // C — CHUNK MODE NEVER ATTACHES. Needs no seeding: whatever images exist, a
    // three-programme chunk must come back with none.
    console.log('\n   C. chunk mode never attaches an image')
    {
      await send('عايز اعرف عن برامج الحج')
      const r = await send('اعرضهم كلهم بالتفصيل')
      t(Array.isArray(r.images), 'the test endpoint returns an images array at all')
      t((r.images || []).length === 0, 'a 3-per-message chunk carries NO image',
        JSON.stringify(r.images || []))
      t((r.replies || []).some(x => x && x.length > 0), 'the chunk text was still sent')
    }

    // A + B — seed a descriptor on ONE real offering and drive the real overview →
    // number flow, first fresh, then stale.
    console.log('\n   A/B. a real single-programme reply, fresh then stale')
    const typeRow = (await c.query(
      `SELECT id, "fieldDefs" FROM "OfferingType" WHERE "companyId"=$1 AND "isActive"=true
        ORDER BY "createdAt" LIMIT 1`, [COMPANY])).rows[0]
    const fieldDefs = typeRow ? (typeRow.fieldDefs || []) : []
    imageKey = (fieldDefs.find(f => f.inputType === 'image') || {}).key || null

    if (!typeRow || !imageKey) {
      skip('no OfferingType with an image field — cannot seed a descriptor')
    } else {
      // A trip is keyed on (departure, return); one that shares its dates with another
      // offering is a MULTI-programme reply and correctly attaches nothing. Pick one
      // that is alone on its dates, so a missing image means a real failure.
      const offerings = (await c.query(
        `SELECT id, values FROM "Offering" WHERE "companyId"=$1 AND "offeringTypeId"=$2 AND "isActive"=true`,
        [COMPANY, typeRow.id])).rows
      const depKey = (fieldDefs.find(f => f.role === 'start-date') || {}).key
      const retKey = (fieldDefs.find(f => f.role === 'end-date') || {}).key
      const titleKey = (fieldDefs.find(f => f.role === 'title') || {}).key
      // The rendered detail is built from the trip, not the row: it prints the HOTELS
      // and the dates, never the offering's stored title. Identify the reply by what
      // it actually contains, or the check reports "wrong trip" for the right one.
      const makkahKey  = (fieldDefs.find(f => f.role === 'location') || {}).key
      const madinahKey = (fieldDefs.find(f => f.role === 'location-2') || {}).key
      const today = new Date().toISOString().slice(0, 10)

      const future = offerings.filter(o => depKey && o.values[depKey] > today)
      const counts = new Map()
      for (const o of future) {
        const k = `${o.values[depKey]}|${o.values[retKey]}`
        counts.set(k, (counts.get(k) || 0) + 1)
      }
      const solo = future
        .filter(o => counts.get(`${o.values[depKey]}|${o.values[retKey]}`) === 1)
        .sort((a, b) => String(a.values[depKey]).localeCompare(String(b.values[depKey])))[0]

      if (!solo) {
        skip('no future offering is alone on its dates — every reply is multi-programme')
      } else {
        target = solo
        originalValues = JSON.parse(JSON.stringify(solo.values))
        const title = titleKey ? String(solo.values[titleKey] || '') : ''
        const dep = String(solo.values[depKey])
        const month = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو',
                       'أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'][parseInt(dep.slice(5, 7), 10) - 1]
        // Its position among that month's trips, sorted by departure — the same order
        // buildUmrahMonthMessage numbers the cards in.
        const monthTrips = [...new Set(future
          .filter(o => String(o.values[depKey]).slice(0, 7) === dep.slice(0, 7))
          .map(o => `${o.values[depKey]}|${o.values[retKey]}`))].sort()
        const n = monthTrips.indexOf(`${dep}|${solo.values[retKey]}`) + 1
        console.log(`   seeding "${title}" dep=${dep} → ${month} trip #${n}`)

        const setImages = async json => {
          await c.query(`UPDATE "Offering" SET values = jsonb_set(values, $2, $3::jsonb) WHERE id=$1`,
            [solo.id, `{${imageKey}}`, JSON.stringify(json)])
          await bust()
        }

        const drive = async () => {
          await nuke()
          await send(`عايز عمرة ${month}`)
          return await send(String(n))
        }

        const fp = fingerprint(solo.values, fieldDefs)
        t(fp !== '', 'the offering has price fields to fingerprint')

        // A — FRESH
        await setImages([descriptor(fp)])
        const makkah  = makkahKey  ? String(solo.values[makkahKey]  || '') : ''
        const madinah = madinahKey ? String(solo.values[madinahKey] || '') : ''
        const isOurTrip = r => !!r && !!makkah && !!madinah && r.includes(makkah) && r.includes(madinah)

        const fresh = await drive()
        const reachedIt = (fresh.replies || []).some(isOurTrip)
        if (!reachedIt) {
          // Never a pass on an unresolved trip: say so and assert nothing.
          skip(`could not resolve trip #${n} for "${title}" — the reply was about something else`)
          console.log(`      got: ${JSON.stringify((fresh.replies || [])[0] || '').slice(0, 160)}`)
        } else {
          t((fresh.images || []).length === 1, 'A. a FRESH image attaches to a single-programme reply',
            JSON.stringify(fresh.images || []))
          t(!!(fresh.images || [])[0] && !fresh.images[0].caption.includes('جنيه'),
            `its caption carries no price — "${((fresh.images || [])[0] || {}).caption}"`)

          // B — STALE: same offering, same flow, one changed fingerprint.
          await setImages([descriptor('deadbeef'.repeat(8))])
          const stale = await drive()
          t((stale.images || []).length === 0, 'B. a STALE image is REFUSED',
            JSON.stringify(stale.images || []))
          t((stale.replies || []).some(isOurTrip),
            'B. and the TEXT IS STILL SENT — fail-closed, not fail-silent')
          t(logBuf.join('').includes('IMAGE_STALE_BLOCKED'),
            'B. the refusal was logged LOUDLY as IMAGE_STALE_BLOCKED')
        }
      }
    }
  } catch (e) {
    console.error(`\nFATAL: ${e.message}`)
    fail++
  } finally {
    // Restore the offering exactly as found. Never delete, never deactivate.
    if (target && originalValues && imageKey) {
      const had = Object.prototype.hasOwnProperty.call(originalValues, imageKey)
      await c.query(
        had ? `UPDATE "Offering" SET values = jsonb_set(values, $2, $3::jsonb) WHERE id=$1`
            : `UPDATE "Offering" SET values = values - $2 WHERE id=$1`,
        had ? [target.id, `{${imageKey}}`, JSON.stringify(originalValues[imageKey])]
            : [target.id, imageKey],
      ).catch(e => console.error(`RESTORE FAILED for ${target.id}: ${e.message}`))
      await bust().catch(() => {})
      console.log(`\nrestored ${target.id}.${imageKey}`)
    }
    await nuke().catch(() => {})
    stopServer(); c.release(); await pool.end()
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`)
  if (fail > 0) console.log('An image could reach a customer carrying a price that no longer applies.')
  process.exit(fail === 0 ? 0 : 1)
})()
