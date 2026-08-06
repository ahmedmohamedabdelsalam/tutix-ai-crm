/**
 * AUDIT — find offerings whose values object is missing keys it should have.
 *
 * Motivated by the PATCH-replaces-values bug: the admin form submits only the
 * fieldDefs keys, so any key outside the fieldDefs was deleted on every save. This
 * reports two distinct things per OfferingType:
 *
 *   1. EXTRA KEYS — keys present on rows but NOT in fieldDefs. These are exactly
 *      the keys a form save used to strip. Their existence is what made the bug
 *      destructive; a type with none was never at risk.
 *   2. MISSING KEYS — rows lacking a key that its peers (and, for hajj, the
 *      catalog.hajjPrograms source) have. These are the damaged rows.
 *
 * READ-ONLY — writes nothing.
 *
 *   node scripts/offering-key-audit.js
 */
'use strict'
const { Pool } = require('pg')
require('dotenv').config()

const CO = process.env.DEFAULT_COMPANY_ID
if (!CO) { console.error('FATAL: DEFAULT_COMPANY_ID not set'); process.exit(1) }

const pool = new Pool({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL })
const parseDefs = raw => (Array.isArray(raw) ? raw : typeof raw === 'string' ? JSON.parse(raw) : [])

;(async () => {
  const c = await pool.connect()
  let damaged = 0, atRisk = 0
  try {
    const types = (await c.query(
      `SELECT id, name, "fieldDefs" FROM "OfferingType" WHERE "companyId"=$1 ORDER BY "sortOrder"`, [CO])).rows

    for (const t of types) {
      const defs = parseDefs(t.fieldDefs)
      const defKeys = new Set(defs.map(d => d.key))
      const rows = (await c.query(
        `SELECT id, values AS v, "isActive" FROM "Offering"
          WHERE "companyId"=$1 AND "offeringTypeId"=$2 ORDER BY "sortOrder"`, [CO, t.id])).rows

      console.log(`\n${'═'.repeat(78)}`)
      console.log(`TYPE "${t.name}" — ${defs.length} fieldDefs, ${rows.length} offerings`)
      console.log('═'.repeat(78))
      if (rows.length === 0) { console.log('  (no offerings)'); continue }

      // 1. Keys present on rows but outside the fieldDefs — the strip-risk surface.
      const extra = new Map()
      for (const r of rows)
        for (const k of Object.keys(r.v)) if (!defKeys.has(k)) extra.set(k, (extra.get(k) ?? 0) + 1)

      if (extra.size === 0) {
        console.log(`  EXTRA KEYS (outside fieldDefs): none — a form save could not strip anything here`)
      } else {
        atRisk += extra.size
        console.log(`  EXTRA KEYS (outside fieldDefs) — these are what a save used to delete:`)
        for (const [k, n] of [...extra].sort((a, b) => b[1] - a[1]))
          console.log(`    ⚠ ${k.padEnd(20)} present on ${n}/${rows.length} rows`)
      }

      // 2. Rows missing a key that the majority of their peers carry.
      const freq = new Map()
      for (const r of rows) for (const k of Object.keys(r.v)) freq.set(k, (freq.get(k) ?? 0) + 1)
      const expected = [...freq].filter(([, n]) => n > rows.length / 2).map(([k]) => k)

      const bad = []
      for (const r of rows) {
        const miss = expected.filter(k => !(k in r.v))
        if (miss.length) bad.push({ name: r.v.name ?? r.id, miss })
      }
      if (bad.length === 0) {
        console.log(`  MISSING KEYS: none — every row carries all ${expected.length} common keys`)
      } else {
        damaged += bad.length
        console.log(`  MISSING KEYS — rows lacking a key most of their peers have:`)
        for (const b of bad) console.log(`    ❌ ${String(b.name).slice(0, 44).padEnd(46)} missing: ${b.miss.join(', ')}`)
      }

      // 3. Hajj only: cross-check against the untouched JSON source of truth.
      if (t.name === 'حج') {
        const cat = (await c.query(`SELECT catalog FROM "CompanyAIConfig" WHERE "companyId"=$1`, [CO])).rows[0].catalog
        const src = cat.hajjPrograms || []
        console.log(`  SOURCE CROSS-CHECK vs catalog.hajjPrograms (${src.length} programmes):`)
        let issues = 0
        for (const r of rows) {
          const p = src.find(x => x.id === r.v.id) || src.find(x => x.name === r.v.name)
          if (!p) { console.log(`    ⚠ ${String(r.v.name).slice(0, 44)} — no source match (created outside the seed?)`); issues++; continue }
          const wantHl = (p.highlights ?? []).length
          const haveHl = r.v.contentJson && Array.isArray(r.v.contentJson.highlights) ? r.v.contentJson.highlights.length : null
          if (haveHl === null) { console.log(`    ❌ ${String(r.v.name).slice(0, 44).padEnd(46)} contentJson MISSING (source has ${wantHl} highlights)`); issues++ }
          else if (haveHl !== wantHl) { console.log(`    ❌ ${String(r.v.name).slice(0, 44).padEnd(46)} highlights ${haveHl} ≠ source ${wantHl}`); issues++ }
        }
        if (issues === 0) console.log(`    ✅ every row matches its source on contentJson/highlights`)
        damaged += issues
      }
    }

    console.log(`\n${'═'.repeat(78)}`)
    console.log(`RESULT: ${damaged} damaged row-issue(s); ${atRisk} extra-key surface(s) that a save would have stripped.`)
    console.log(damaged === 0 ? '✅ no data loss found beyond what has been repaired.' : '❌ damage found — see above.')
  } finally { c.release(); await pool.end() }
})()
