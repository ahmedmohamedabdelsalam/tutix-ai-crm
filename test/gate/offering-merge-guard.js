/**
 * GATE — OFFERING SAVE MUST NOT DROP KEYS  (data-loss class)
 *
 * The admin form submits only the keys it renders (the OfferingType's fieldDefs).
 * Rows legitimately carry keys no form knows about — hajj programmes keep their
 * dates, hotels and highlights in contentJson/sectionsJson. When the PATCH route
 * wrote `values` wholesale it deleted those on every save: an admin editing a
 * price silently destroyed the programme's entire detail content and the customer
 * got a bare price line. It went unnoticed for two days.
 *
 * This drives the REAL dashboard API — not a reimplementation of the merge — so it
 * fails if anyone reintroduces a replacing write, in the route or anywhere upstream.
 *
 * SAFETY: creates nothing, deletes nothing, and changes no customer-visible value.
 * The payload it sends is rebuilt from the row's OWN current values, so a correct
 * save is a no-op. It snapshots the row first and restores it in a finally block if
 * anything moved. Worst case the row ends byte-identical to how it started.
 *
 *   node test/gate/offering-merge-guard.js
 *   DASHBOARD_URL=http://localhost:3000 node test/gate/offering-merge-guard.js
 *
 * Requires the dashboard running locally and ADMIN_JWT_SECRET (read from the
 * dashboard's .env.local by default; DASHBOARD_ENV overrides the path).
 */
'use strict'
const http = require('http')
const https = require('https')
const crypto = require('crypto')
const { Pool } = require('pg')
require('dotenv').config()

const DASH = process.env.DASHBOARD_URL || 'http://localhost:3000'
const DASH_ENV = process.env.DASHBOARD_ENV || 'C:/Users/Computec/tutix-dashboard/.env.local'
const CO = process.env.DEFAULT_COMPANY_ID

require('dotenv').config({ path: DASH_ENV })
const SECRET = process.env.ADMIN_JWT_SECRET

if (!CO) { console.error('FATAL: DEFAULT_COMPANY_ID not set'); process.exit(1) }
if (!SECRET) { console.error(`FATAL: ADMIN_JWT_SECRET not found (looked in ${DASH_ENV})`); process.exit(1) }

// Mint the same HS256 admin JWT lib/auth.ts issues, without pulling jsonwebtoken
// into this repo for one test helper. Must stay in step with verifyToken(): it
// requires type==='admin' and a valid exp.
function signAdminJwt(secret, ttlSeconds = 600) {
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ email: 'gate@test.local', type: 'admin', iat: now, exp: now + ttlSeconds })}`
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url')
  return `${body}.${sig}`
}

const TOKEN = signAdminJwt(SECRET)
const pool = new Pool({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL })
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const parseDefs = raw => (Array.isArray(raw) ? raw : typeof raw === 'string' ? JSON.parse(raw) : [])

function patch(id, values) {
  const url = new URL(`${DASH}/api/admin/offerings/${id}?companyId=${encodeURIComponent(CO)}`)
  const data = JSON.stringify({ values })
  const client = url.protocol === 'https:' ? https : http
  return new Promise((resolve, reject) => {
    const req = client.request({
      hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search, method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        Cookie: `tutix_session=${TOKEN}`,
      },
    }, res => { let b = ''; res.on('data', d => b += d); res.on('end', () => resolve({ status: res.statusCode, body: b })) })
    req.on('error', reject)
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('timeout')) })
    req.write(data); req.end()
  })
}

const readValues = async (c, id) =>
  (await c.query('SELECT values FROM "Offering" WHERE id=$1', [id])).rows[0].values

;(async () => {
  const c = await pool.connect()
  let pass = 0, fail = 0, snapshot = null, target = null
  const uncovered = []
  const t = (ok, label, detail) => {
    if (ok) { console.log(`  ✅ ${label}`); pass++ }
    else { console.log(`  ❌ ${label}${detail ? `\n     ${detail}` : ''}`); fail++ }
  }

  try {
    // Reachability first — a gate that cannot verify must not report success.
    const up = await patch('__probe__', {}).then(r => r.status !== undefined).catch(() => false)
    if (!up) {
      console.error(`FATAL: dashboard not reachable at ${DASH}`)
      console.error('Start it first:  cd tutix-dashboard && npm run dev')
      process.exit(1)
    }

    // Cover EVERY type that has rows with extra non-form keys — the hajj row carrying
    // contentJson is the one that actually broke, so testing only the first type found
    // would miss it.
    const types = (await c.query(
      `SELECT id, name, "fieldDefs" FROM "OfferingType" WHERE "companyId"=$1 ORDER BY "sortOrder"`, [CO])).rows
    const targets = []
    for (const ty of types) {
      const fieldDefs = parseDefs(ty.fieldDefs)
      const defKeys = new Set(fieldDefs.map(d => d.key))
      const rows = (await c.query(
        `SELECT id, values FROM "Offering" WHERE "companyId"=$1 AND "offeringTypeId"=$2 ORDER BY "sortOrder"`,
        [CO, ty.id])).rows
      // Prefer the row with the MOST extra keys — the most to lose.
      let best = null, bestN = 0
      for (const r of rows) {
        const n = Object.keys(r.values).filter(k => !defKeys.has(k)).length
        if (n > bestN) { best = r; bestN = n }
      }
      if (best) targets.push({ ...best, typeName: ty.name, fieldDefs, defKeys })
    }
    if (targets.length === 0) {
      console.error('FATAL: no offering carries keys outside its fieldDefs — nothing to protect.')
      console.error('If that is genuinely true now, this gate is vacuous and must be revisited.')
      process.exit(1)
    }

    for (const tgt of targets) {
      target = tgt
      const extras = Object.keys(tgt.values).filter(k => !tgt.defKeys.has(k))
      snapshot = JSON.parse(JSON.stringify(tgt.values))
      const restore = async () => { await c.query('UPDATE "Offering" SET values=$2 WHERE id=$1', [tgt.id, snapshot]) }

      console.log(`\n[${tgt.typeName}] ${String(tgt.values.name).slice(0, 52)}`)
      console.log(`  extra keys at risk: ${extras.join(', ')}`)

      // The invariant is one-directional: a save may MATERIALISE a fieldDef key the
      // row happened to lack (the form posts '' for it), which is not loss. What must
      // never happen is a key disappearing, or a value nobody submitted changing.
      const assertNoLoss = (after, label, submitted) => {
        for (const k of extras)
          t(k in after && eq(after[k], snapshot[k]), `${label} preserves "${k}"`,
            k in after ? 'present but CHANGED' : 'KEY DELETED — the data-loss bug is back')
        const lost = Object.keys(snapshot).filter(k => !(k in after))
        t(lost.length === 0, `${label} loses no key at all`, lost.length ? `lost: ${lost.join(', ')}` : '')

        // The invariant, precisely: a key the payload did not carry must come back
        // byte-identical. Keys the payload DID carry are the form's to rewrite.
        const unsubmitted = Object.keys(snapshot).filter(k => !submitted.has(k))
        const changed = unsubmitted.filter(k => k in after && !eq(after[k], snapshot[k]))
        t(changed.length === 0, `${label} changes no unsubmitted value (${unsubmitted.length} checked)`,
          changed.length ? `changed: ${changed.join(', ')}` : '')

        const added = Object.keys(after).filter(k => !(k in snapshot))
        if (added.length) console.log(`     ℹ materialised empty fieldDef key(s): ${added.join(', ')} (not loss)`)
        const norm = [...submitted].filter(k => k in snapshot && k in after && !eq(after[k], snapshot[k]))
        if (norm.length) console.log(`     ℹ form normalised submitted field(s): ${norm.join(', ')} (null → '')`)
      }

      // ── CASE 1 — a full form save, exactly as app/admin/offerings/page.tsx builds it:
      //    every fieldDef key from the row's own current values, and nothing else.
      const formPayload = {}
      for (const d of tgt.fieldDefs)
        formPayload[d.key] = tgt.values[d.key] ?? (d.inputType === 'checkbox' ? false : '')
      const r1 = await patch(tgt.id, formPayload)

      // A type the agent does not read is refused outright (409), so no save can
      // damage it while it stays unwired. That is not a pass — it is untested, and it
      // USED to print as a skip above a green total. That is the false-PASS shape this
      // project has been bitten by four times over: the check ran, said something
      // reassuring, and the truth was in the part it could not see.
      //
      // Production wires more types than a bare local dashboard does, and the row that
      // actually got destroyed was a HAJJ row on production — precisely the type a
      // local run used to skip. So an uncovered type FAILS: a gate that cannot see a
      // type cannot vouch for it, and the exit code has to say so.
      if (r1.status === 409 && r1.body.includes('مش مربوط')) {
        uncovered.push(tgt.typeName)
        t(false, `type "${tgt.typeName}" is NOT COVERED — the API refuses all writes to it here`,
          `This gate cannot vouch for "${tgt.typeName}": production wires it, this run does not,` + "\n" +
          `     so a merge bug in it would ship green. Set AGENT_WIRED_OFFERING_TYPES as production` + "\n" +
          `     has it (tutix-dashboard/.env.local), restart the dashboard, and re-run.`)
        // Still worth asserting while it is unwired: the refusal must leave the row alone.
        const untouched = await readValues(c, tgt.id)
        t(eq(untouched, snapshot), `refused save left "${tgt.typeName}" row untouched`)
        continue
      }

      t(r1.status === 200, `form save returns 200 (got ${r1.status})`, r1.body.slice(0, 200))
      assertNoLoss(await readValues(c, tgt.id), 'form save', new Set(Object.keys(formPayload)))
      await restore()   // independent cases — case 2 must not inherit case 1's state

      // ── CASE 2 — a genuine PARTIAL patch: one key only. Merge semantics must accept
      //    it (not fail required-field validation for fields it never sent) and leave
      //    everything else untouched.
      const one = tgt.fieldDefs.find(d => d.role === 'price' || d.key === 'pricePerPerson')
        ?? tgt.fieldDefs.find(d => d.inputType !== 'checkbox')
      const r2 = await patch(tgt.id, { [one.key]: tgt.values[one.key] ?? '' })
      t(r2.status === 200, `partial save of "${one.key}" returns 200 (got ${r2.status})`, r2.body.slice(0, 200))
      const after2 = await readValues(c, tgt.id)
      assertNoLoss(after2, 'partial save', new Set([one.key]))
      t(eq(after2, snapshot), 'partial save leaves the row byte-identical')
      await restore()
    }
  } catch (e) {
    console.error(`\nFATAL: ${e.message}`)
    fail++
  } finally {
    // Restore if anything moved — this gate must never be the cause of damage.
    if (snapshot && target) {
      const now = await readValues(c, target.id).catch(() => null)
      if (now && !eq(now, snapshot)) {
        await c.query('UPDATE "Offering" SET values=$2 WHERE id=$1', [target.id, snapshot])
        console.log('\n⚠  row had changed — restored from snapshot')
      }
    }
    c.release(); await pool.end()
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`)
  if (uncovered.length) {
    console.log(`\n⛔ UNCOVERED TYPES: ${uncovered.join(', ')}`)
    console.log('   Not tested at all — counted as FAILURES, not skips. A green total over an')
    console.log('   untested type is exactly the false PASS this suite exists to prevent.')
    console.log('   Fix: set AGENT_WIRED_OFFERING_TYPES in tutix-dashboard/.env.local, then restart it.')
  }
  if (fail > uncovered.length) console.log('An offering save is dropping keys. This is silent customer-facing data loss.')
  // Belt and braces: an uncovered type already incremented `fail` via t(false), but
  // state the condition explicitly so a future refactor of t() cannot quietly
  // restore exit 0 — the exit code is the only part CI actually reads.
  process.exit(fail === 0 && uncovered.length === 0 ? 0 : 1)
})()
