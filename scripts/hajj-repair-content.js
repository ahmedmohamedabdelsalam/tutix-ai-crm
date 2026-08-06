/**
 * REPAIR — restore contentJson / sectionsJson on a hajj Offering row.
 *
 * The dashboard's offering edit form submits only the keys it renders (the 25
 * fieldDefs). contentJson and sectionsJson are not among them, so any admin edit
 * to a hajj program silently drops both — taking that program's dates, hotels and
 * highlights with them. The customer then sees a bare price line.
 *
 * Source of truth is catalog.hajjPrograms (the untouched JSON fallback), passed
 * through the same buildValues() transform scripts/hajj-h2-populate.js used to
 * create the rows. catalog.hajjPrograms is READ ONLY here — never written.
 *
 *   node scripts/hajj-repair-content.js                # DRY RUN (default)
 *   node scripts/hajj-repair-content.js --commit       # write
 *
 * Writes only the two missing keys. Every other field, including pricePerPerson,
 * is left exactly as it is. Verify with: node test/gate/hajj-golden-dump.js --bridge
 */
'use strict'
const { Pool } = require('pg')
require('dotenv').config()

const COMMIT = process.argv.includes('--commit')
const CO = process.env.DEFAULT_COMPANY_ID
if (!CO) { console.error('FATAL: DEFAULT_COMPANY_ID not set'); process.exit(1) }

const SECTIONS = [['medina', 'medina'], ['makkah', 'makkah'], ['aziziyah', 'aziziyah'], ['tahseen', 'tahseen']]

/** contentJson / sectionsJson exactly as hajj-h2-populate.js buildValues() derives them. */
function deriveContent(p) {
  const sectionsJson = {}
  for (const [src] of SECTIONS) {
    const sec = p[src]
    if (!sec) continue
    const rest = {}
    for (const k of ['roomType', 'meals', 'note', 'durationDays']) if (sec[k] !== undefined) rest[k] = sec[k]
    sectionsJson[src] = rest
  }
  const contentJson = {
    highlights:     p.highlights ?? [],
    scholarNote:    p.scholarNote ?? null,
    subLevels:      p.subLevels ?? null,
    transitToMecca: p.transitToMecca ?? null,
    arafat:         p.arafat ?? null,
    mina:           p.mina ?? null,
    manasikhMeals:  p.manasikhMeals ?? null,
  }
  return { sectionsJson, contentJson }
}

const pool = new Pool({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL })

;(async () => {
  const c = await pool.connect()
  try {
    const cat = (await c.query(`SELECT catalog FROM "CompanyAIConfig" WHERE "companyId"=$1`, [CO])).rows[0].catalog
    const source = cat.hajjPrograms || []
    const rows = (await c.query(`
      SELECT o.id, o.values AS v FROM "Offering" o JOIN "OfferingType" t ON t.id=o."offeringTypeId"
       WHERE o."companyId"=$1 AND t.name='حج' ORDER BY o."sortOrder"`, [CO])).rows

    const damaged = rows.filter(r => !r.v.contentJson || !r.v.sectionsJson)
    if (damaged.length === 0) { console.log('✅ nothing to repair — all rows have contentJson + sectionsJson'); return }

    console.log(`${damaged.length} row(s) missing content:\n`)
    let plan = []
    for (const r of damaged) {
      const p = source.find(x => x.id === r.v.id) || source.find(x => x.name === r.v.name)
      if (!p) { console.log(`  ❌ ${r.v.name} — NO MATCH in catalog.hajjPrograms, cannot repair`); continue }
      const { sectionsJson, contentJson } = deriveContent(p)
      console.log(`  ${r.v.name}`)
      console.log(`    matched source by : ${p.id === r.v.id ? 'id' : 'name'} (${p.id})`)
      console.log(`    sectionsJson      : ${JSON.stringify(sectionsJson)}`)
      console.log(`    contentJson       : ${contentJson.highlights.length} highlight line(s)`)
      for (const h of contentJson.highlights) console.log(`      · ${h.slice(0, 88)}`)
      const others = Object.entries(contentJson).filter(([k, val]) => k !== 'highlights' && val !== null)
      console.log(`    other content keys: ${others.length ? others.map(([k]) => k).join(', ') : 'none (all null)'}`)
      console.log(`    price UNCHANGED   : ${JSON.stringify(r.v.pricePerPerson)}`)
      plan.push({ id: r.id, sectionsJson, contentJson })
    }

    if (!COMMIT) { console.log(`\nDRY RUN — would write 2 keys on ${plan.length} row(s). Re-run with --commit.`); return }

    await c.query('BEGIN')
    for (const { id, sectionsJson, contentJson } of plan) {
      const res = await c.query(`
        UPDATE "Offering"
           SET values = jsonb_set(jsonb_set(values, '{sectionsJson}', $2::jsonb), '{contentJson}', $3::jsonb),
               "updatedAt" = now()
         WHERE id=$1 AND "companyId"=$4`,
        [id, JSON.stringify(sectionsJson), JSON.stringify(contentJson), CO])
      if (res.rowCount !== 1) throw new Error(`row ${id}: updated ${res.rowCount} rows — aborting`)
    }
    await c.query('COMMIT')
    console.log(`\n✅ repaired ${plan.length} row(s) — contentJson + sectionsJson restored, nothing else touched`)
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    console.error('❌ rolled back:', e.message); process.exitCode = 1
  } finally { c.release(); await pool.end() }
})()
