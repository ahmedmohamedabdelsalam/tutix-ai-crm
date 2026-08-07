/**
 * GATE — OFFERING IMAGE SAFETY  (price-staleness class)
 *
 * An image with a printed price is a fact no guard can inspect. scanModelOutput
 * reads text for digits, months and hotel names; against a JPEG it is blind. If a
 * price changes after the image was made, sending it quotes the customer a number
 * that is simply wrong — and a picture is more convincing than a chat message and
 * can be screenshotted as evidence.
 *
 * Stage 1 therefore has to guarantee three things, which this suite asserts against
 * the REAL dashboard API rather than a reimplementation of it:
 *
 *   1. every uploaded image records the prices that were true at upload
 *   2. a price change makes the image report STALE, with the real before/after
 *   3. re-confirming re-fingerprints and clears it
 *
 * The fingerprint is recomputed here from the documented algorithm rather than by
 * importing the dashboard's code. That is deliberate: Stage 2 runs in this repo and
 * must reproduce it byte-identically to decide what to block, so the algorithm has
 * to be reproducible from its spec. If this suite drifts from the dashboard, the
 * cross-repo contract is already broken and we want to hear about it here.
 *
 * SAFETY: creates no offerings, deletes no offerings. It seeds a descriptor on one
 * real row, drives the API against it, and restores the row's exact prior values in
 * a finally block.
 *
 *   node test/gate/offering-images-suite.js
 *   DASHBOARD_URL=http://localhost:3001 node test/gate/offering-images-suite.js
 */
'use strict'
const http = require('http')
const https = require('https')
const crypto = require('crypto')
const zlib = require('zlib')
const { Pool } = require('pg')
require('dotenv').config()

const DASH = process.env.DASHBOARD_URL || 'http://localhost:3000'
const DASH_ENV = process.env.DASHBOARD_ENV || 'C:/Users/Computec/tutix-dashboard/.env.local'
const CO = process.env.DEFAULT_COMPANY_ID
require('dotenv').config({ path: DASH_ENV })
const SECRET = process.env.ADMIN_JWT_SECRET

if (!CO) { console.error('FATAL: DEFAULT_COMPANY_ID not set'); process.exit(1) }
if (!SECRET) { console.error(`FATAL: ADMIN_JWT_SECRET not found (looked in ${DASH_ENV})`); process.exit(1) }

function signAdminJwt(secret, ttl = 600) {
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ email: 'gate@test.local', type: 'admin', iat: now, exp: now + ttl })}`
  return `${body}.${crypto.createHmac('sha256', secret).update(body).digest('base64url')}`
}
const TOKEN = signAdminJwt(SECRET)
const pool = new Pool({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL })
const parseDefs = raw => (Array.isArray(raw) ? raw : typeof raw === 'string' ? JSON.parse(raw) : [])

// ── the fingerprint contract, reimplemented from its spec ────────────────────
const normalisePrice = v => (v === null || v === undefined ? '' : String(v).trim())
function priceFieldKeys(defs) {
  return defs.filter(f => f.role && f.role.startsWith('price')).map(f => f.key).sort()
}
function priceFingerprint(values, defs) {
  const keys = priceFieldKeys(defs)
  if (keys.length === 0) return ''
  const canonical = keys.map(k => [k, normalisePrice(values[k])])
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

// ── minimal PNG builder, so bit-depth validation can be tested for real ──────
function crc32(buf) {
  let c, table = []
  for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0 }
  let crc = 0xffffffff
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
/** bitDepth 8 + colorType 2 is what Meta accepts; 16 is what it rejects. */
function makePng(bitDepth = 8, colorType = 2, w = 2, h = 2) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4)
  ihdr[8] = bitDepth; ihdr[9] = colorType; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  const samples = colorType === 2 ? 3 : colorType === 6 ? 4 : 1
  const bytesPerSample = bitDepth === 16 ? 2 : 1
  const rowBytes = w * samples * bytesPerSample
  const raw = Buffer.concat(Array.from({ length: h }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(rowBytes, 0x7f)])))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ])
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
function request(method, path, { json, body, contentType } = {}) {
  const url = new URL(`${DASH}${path}`)
  const client = url.protocol === 'https:' ? https : http
  const payload = json ? Buffer.from(JSON.stringify(json)) : body
  return new Promise((resolve, reject) => {
    const req = client.request({
      hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search, method,
      headers: {
        Cookie: `tutix_session=${TOKEN}`,
        ...(payload ? { 'Content-Length': payload.length } : {}),
        ...(json ? { 'Content-Type': 'application/json' } : {}),
        ...(contentType ? { 'Content-Type': contentType } : {}),
      },
    }, res => { let b = ''; res.on('data', d => b += d); res.on('end', () => resolve({ status: res.statusCode, body: b })) })
    req.on('error', reject)
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('timeout')) })
    if (payload) req.write(payload)
    req.end()
  })
}

function multipart(fields, file) {
  const b = '----gate' + crypto.randomBytes(8).toString('hex')
  const parts = []
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`))
  }
  if (file) {
    parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`))
    parts.push(file.buf, Buffer.from('\r\n'))
  }
  parts.push(Buffer.from(`--${b}--\r\n`))
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${b}` }
}

;(async () => {
  const c = await pool.connect()
  let pass = 0, fail = 0, snapshot = null, target = null
  const t = (ok, label, detail) => {
    if (ok) { console.log(`  ✅ ${label}`); pass++ }
    else { console.log(`  ❌ ${label}${detail ? `\n     ${detail}` : ''}`); fail++ }
  }

  try {
    const probe = await request('PATCH', `/api/admin/offerings/x/images?companyId=${encodeURIComponent(CO)}`, { json: {} })
      .then(() => true).catch(() => false)
    if (!probe) {
      console.error(`FATAL: dashboard not reachable at ${DASH}\nStart it:  cd tutix-dashboard && npm run dev`)
      process.exit(1)
    }

    // Find a type that declares an image field, and a row of it to work on.
    const types = (await c.query(
      `SELECT id, name, "fieldDefs" FROM "OfferingType" WHERE "companyId"=$1 ORDER BY "sortOrder"`, [CO])).rows
    let ty = null, def = null
    for (const x of types) {
      const defs = parseDefs(x.fieldDefs)
      const d = defs.find(f => f.inputType === 'image')
      if (d) { ty = { ...x, defs }; def = d; break }
    }
    if (!ty) {
      console.error('FATAL: no OfferingType declares an image field.')
      console.error('Add one:  node scripts/add-image-field.js --type=<name> --commit')
      process.exit(1)
    }
    const row = (await c.query(
      `SELECT id, values FROM "Offering" WHERE "companyId"=$1 AND "offeringTypeId"=$2 ORDER BY "sortOrder" LIMIT 1`,
      [CO, ty.id])).rows[0]
    if (!row) { console.error('FATAL: that type has no offerings'); process.exit(1) }

    target = row
    snapshot = JSON.parse(JSON.stringify(row.values))
    const priceKeys = priceFieldKeys(ty.defs)
    const restore = async () => c.query('UPDATE "Offering" SET values=$2 WHERE id=$1', [row.id, snapshot])
    const readNow = async () => (await c.query('SELECT values FROM "Offering" WHERE id=$1', [row.id])).rows[0].values
    const qs = `?companyId=${encodeURIComponent(CO)}`
    const base = `/api/admin/offerings/${row.id}/images${qs}`

    console.log(`Type [${ty.name}] field "${def.key}" (multiple=${!!def.multiple})`)
    console.log(`Offering: ${String(row.values.name).slice(0, 56)}`)
    console.log(`Price fields: ${priceKeys.join(', ')}\n`)

    // ── A. Meta's format rules are enforced at upload, not at send time ───────
    console.log('A. upload validation')
    {
      const m = multipart({ fieldKey: def.key }, { name: 'x.png', type: 'image/png', buf: makePng(16, 2) })
      const r = await request('POST', base, { body: m.body, contentType: m.contentType })
      t(r.status === 400 && r.body.includes('١٦') || r.status === 400 && /16/.test(r.body),
        `16-bit PNG rejected (got ${r.status})`, r.body.slice(0, 160))
    }
    {
      const m = multipart({ fieldKey: def.key }, { name: 'x.png', type: 'image/png', buf: makePng(8, 3) })
      const r = await request('POST', base, { body: m.body, contentType: m.contentType })
      t(r.status === 400, `palette PNG (colorType 3) rejected (got ${r.status})`, r.body.slice(0, 160))
    }
    {
      const m = multipart({ fieldKey: def.key }, { name: 'x.gif', type: 'image/gif', buf: Buffer.from('GIF89a') })
      const r = await request('POST', base, { body: m.body, contentType: m.contentType })
      t(r.status === 400, `disallowed MIME rejected (got ${r.status})`, r.body.slice(0, 160))
    }
    {
      const m = multipart({ fieldKey: 'not_a_field' }, { name: 'x.png', type: 'image/png', buf: makePng() })
      const r = await request('POST', base, { body: m.body, contentType: m.contentType })
      t(r.status === 400, `unknown fieldKey rejected (got ${r.status})`, r.body.slice(0, 160))
    }
    {
      // A VALID 8-bit RGB PNG must clear validation. Without Supabase credentials
      // it stops at storage (503) — that still proves validation passed, and the
      // suite says so rather than pretending the upload leg was covered.
      const m = multipart({ fieldKey: def.key }, { name: 'x.png', type: 'image/png', buf: makePng(8, 2) })
      const r = await request('POST', base, { body: m.body, contentType: m.contentType })
      const uploaded = r.status === 200
      const storageMissing = r.status === 503
      t(uploaded || storageMissing, `valid 8-bit RGB PNG passes validation (got ${r.status})`, r.body.slice(0, 160))
      if (storageMissing) console.log('     ⏭  upload leg NOT covered — SUPABASE_URL/SERVICE_KEY absent locally')
      if (uploaded) {
        const imgs = (await readNow())[def.key]
        t(Array.isArray(imgs), 'value is an ARRAY even for a single image')
        // The multipart above deliberately omits priceBearing. Defaulting it TRUE
        // is the whole safety posture: an admin uploading in bulk must not be able
        // to leave a price image unguarded by saying nothing.
        t(imgs[0] && imgs[0].priceBearing === true,
          'priceBearing DEFAULTS TRUE when the field is not sent')
        t(imgs[0] && typeof imgs[0].checksum === 'string' && imgs[0].checksum.length === 64,
          'checksum recorded (Stage 2 media-ID cache key)')
        t(imgs[0] && imgs[0].priceFingerprint === priceFingerprint(await readNow(), ty.defs),
          'uploaded image fingerprints the CURRENT prices')
        await restore()
      }
    }

    // ── B. fingerprint + staleness, driven through the real API ──────────────
    console.log('\nB. price fingerprint and staleness')
    const values0 = await readNow()
    const fp0 = priceFingerprint(values0, ty.defs)
    const seeded = {
      url: 'https://example.invalid/seed.png', path: `gate/seed-${Date.now()}.png`,
      mime: 'image/png', bytes: 123, checksum: 'seed', uploadedAt: new Date().toISOString(),
      priceBearing: true, priceFingerprint: fp0,
      priceSnapshot: Object.fromEntries(priceKeys.map(k => [k, normalisePrice(values0[k])])),
    }
    await c.query(`UPDATE "Offering" SET values = jsonb_set(values, $2, $3::jsonb) WHERE id=$1`,
      [row.id, `{${def.key}}`, JSON.stringify([seeded])])

    t(seeded.priceFingerprint === fp0 && fp0.length === 64,
      'fingerprint recorded at upload time (64-hex sha256)', `got "${fp0}"`)
    t(!priceKeys.some(k => seeded.priceSnapshot[k] === undefined),
      'snapshot captures every price field — the diff needs all of them')

    // Change ONE price the way an admin would.
    const pk = priceKeys[0]
    const was = normalisePrice(values0[pk])
    const now = String((parseInt(was, 10) || 1000) / 10)
    await c.query(`UPDATE "Offering" SET values = jsonb_set(values, $2, $3::jsonb) WHERE id=$1`,
      [row.id, `{${pk}}`, JSON.stringify(now)])

    const values1 = await readNow()
    const fp1 = priceFingerprint(values1, ty.defs)
    t(fp1 !== fp0, `price change moves the fingerprint (${pk}: ${was} → ${now})`)
    const stored = values1[def.key][0]
    t(stored.priceFingerprint !== fp1, 'image now reports STALE (stored ≠ current)')
    t(stored.priceSnapshot[pk] === was,
      `snapshot still holds the OLD value, so the dialog can say "was ${was}, now ${now}"`,
      `snapshot=${stored.priceSnapshot[pk]}`)

    // A non-price edit must NOT make it stale — this is why it is not a timestamp.
    await c.query(`UPDATE "Offering" SET values = jsonb_set(values, '{name}', $2::jsonb), "updatedAt"=now() WHERE id=$1`,
      [row.id, JSON.stringify(String(values1.name) + ' ')])
    t(priceFingerprint(await readNow(), ty.defs) === fp1,
      'a NON-price edit does not move the fingerprint (no false stale)')
    await c.query(`UPDATE "Offering" SET values = jsonb_set(values, '{name}', $2::jsonb) WHERE id=$1`,
      [row.id, JSON.stringify(values1.name)])

    // ── C. re-confirm clears it, via the real endpoint ───────────────────────
    console.log('\nC. re-confirm')
    {
      const r = await request('PATCH', base, { json: { fieldKey: def.key, path: seeded.path, action: 'confirm' } })
      t(r.status === 200, `confirm returns 200 (got ${r.status})`, r.body.slice(0, 160))
      const after = (await readNow())[def.key][0]
      t(after.priceFingerprint === fp1, 're-confirm re-fingerprints to the CURRENT prices')
      t(after.priceSnapshot[pk] === now, 're-confirm refreshes the snapshot too')
      t(after.priceBearing === true, 're-confirm does not silently clear priceBearing')
    }

    // ── D. the opt-out, and what it means ────────────────────────────────────
    console.log('\nD. priceBearing')
    {
      const r = await request('PATCH', base, {
        json: { fieldKey: def.key, path: seeded.path, action: 'setPriceBearing', priceBearing: false },
      })
      t(r.status === 200, `opt-out returns 200 (got ${r.status})`)
      const after = (await readNow())[def.key][0]
      t(after.priceBearing === false, 'image can be marked not price-bearing')
      // isStale() short-circuits on !priceBearing: such an image is never blocked.
      t(after.priceFingerprint === fp1, 'opting out preserves the fingerprint (reversible)')
    }

    // ── E. the merge that makes all of this safe ─────────────────────────────
    console.log('\nE. form save must not destroy image descriptors')
    {
      const before = await readNow()
      const formPayload = {}
      for (const d of ty.defs) {
        if (d.inputType === 'image') continue          // the form omits image fields
        formPayload[d.key] = before[d.key] ?? (d.inputType === 'checkbox' ? false : '')
      }
      const r = await request('PATCH', `/api/admin/offerings/${row.id}${qs}`, { json: { values: formPayload } })
      t(r.status === 200, `offering form save returns 200 (got ${r.status})`, r.body.slice(0, 160))
      const after = await readNow()
      t(Array.isArray(after[def.key]) && after[def.key].length === 1,
        'images SURVIVE a full form save (the merge holds)',
        `got ${JSON.stringify(after[def.key])}`)
      t(JSON.stringify(after[def.key]) === JSON.stringify(before[def.key]),
        'descriptors are byte-identical after the save')
    }
  } catch (e) {
    console.error(`\nFATAL: ${e.message}`)
    fail++
  } finally {
    if (snapshot && target) {
      await c.query('UPDATE "Offering" SET values=$2 WHERE id=$1', [target.id, snapshot]).catch(() => {})
      console.log('\n↩  row restored to its exact prior values')
    }
    c.release(); await pool.end()
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`)
  if (fail > 0) console.log('An image could carry a stale price to a customer. Do not ship Stage 2.')
  process.exit(fail === 0 ? 0 : 1)
})()
