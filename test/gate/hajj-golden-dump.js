/**
 * H1 — HAJJ GOLDEN BASELINE
 *
 * Dumps every hajj-derived prebuilt string produced by the CURRENT (JSON) path to
 * test/gate/hajj-golden.json. That file is the oracle for H4: after the H3 bridge
 * is built, re-running with USE_DB_HAJJ=true must produce a byte-identical dump.
 *
 * READ-ONLY. Reads CompanyAIConfig; writes only the golden file.
 *
 *   node test/gate/hajj-golden-dump.js            # write/refresh the golden file
 *   node test/gate/hajj-golden-dump.js --check    # diff against it, exit 1 on drift
 *   node test/gate/hajj-golden-dump.js --bridge   # H4: build from the Offerings
 *                                                 #     table and diff vs golden
 *
 * Prerequisite: npm run build (reads from dist/).
 */
'use strict'
const fs   = require('fs')
const path = require('path')
const { Pool } = require('pg')
require('dotenv').config()

const { buildIndustryPromptFromDB } = require('../../dist/src/agent/prompts/dynamic-catalog-builder')

const COMPANY_ID   = process.env.DEFAULT_COMPANY_ID
const GOLDEN_PATH  = path.join(__dirname, 'hajj-golden.json')
const CHECK        = process.argv.includes('--check')
const BRIDGE       = process.argv.includes('--bridge')

if (!COMPANY_ID) { console.error('FATAL: DEFAULT_COMPANY_ID not set'); process.exit(1) }

// The 8 hajj-derived surfaces on IndustryPromptParts, plus the AI-visible catalog
// section. Every hajj handler in whatsapp.service.ts reads one of these.
const HAJJ_KEYS = [
  'hajjProgramDetails',
  'hajjOverviewMessage',
  'hajjOverviewDetails',
  'hajjCategoryQuestion',
  'hajjEconomyPrograms',
  'hajjEconomyDetails',
  'hajjFiveStarPrograms',
  'hajjFiveStarDetails',
  'hajjKadanPrograms',
  'hajjKadanDetails',
]

const pool = new Pool({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL })

;(async () => {
  const c = await pool.connect()
  let snapshot
  try {
    const r = await c.query(
      `SELECT c.name AS company_name, a.* FROM "CompanyAIConfig" a
         JOIN "Company" c ON c.id = a."companyId"
        WHERE a."companyId" = $1`, [COMPANY_ID])
    if (r.rows.length === 0) throw new Error('no CompanyAIConfig for ' + COMPANY_ID)
    const cfg = r.rows[0]

    // Default: no override → the legacy JSON path, i.e. today's live behaviour.
    // --bridge: feed the حج Offering rows through the H3 bridge instead. Both must
    // produce byte-identical output; that equality is the whole point of H4.
    let hajjOverride
    if (BRIDGE) {
      const t = await c.query(
        `SELECT id FROM "OfferingType" WHERE "companyId"=$1 AND name='حج' AND "isActive"=true`, [COMPANY_ID])
      if (t.rows.length === 0) throw new Error("no 'حج' OfferingType — run scripts/hajj-h2-populate.js first")
      const rows = await c.query(
        `SELECT values FROM "Offering"
          WHERE "companyId"=$1 AND "offeringTypeId"=$2 AND "isActive"=true
          ORDER BY "sortOrder" ASC`, [COMPANY_ID, t.rows[0].id])
      hajjOverride = rows.rows.map(r => ({ values: r.values }))
      console.log(`[bridge] built from ${hajjOverride.length} حج Offering rows`)
    }

    const parts = buildIndustryPromptFromDB(cfg, cfg.company_name, undefined, hajjOverride)

    snapshot = {
      companyId: COMPANY_ID,
      source: 'catalog.hajjPrograms (JSON path)',   // golden is always the JSON path
    }
    for (const k of HAJJ_KEYS) snapshot[k] = parts[k]

    // The hajj block of the system prompt lives inside `catalog`; capture just that
    // slice so unrelated Umrah edits do not churn the golden file.
    //
    // As of the prompt-slimming change this is EXPECTED to be absent: the hajj
    // programme table is deliberately no longer sent to the model (every hajj path is
    // deterministic, and the output guard would discard any figure it quoted). What
    // remains under this header is the hajj general-knowledge/FAQ prose, which stays.
    // The eleven handler-facing surfaces above are the ones that must never drift.
    const cat = String(parts.catalog ?? '')
    const start = cat.indexOf('برامج الحج')
    snapshot.hajjCatalogSection = start >= 0 ? cat.slice(start) : '(hajj programme table withheld from the model prompt — by design)'

    // Ordering contract from spec §5 — customers reply by number, so this must be
    // asserted explicitly rather than left implicit inside the rendered strings.
    snapshot.orderedProgramNames = (parts.hajjOverviewDetails || []).map(d =>
      (d.split('\n')[0].match(/\*([^*]+)\*/) || [null, '(unparsed)'])[1])
  } finally { c.release(); await pool.end() }

  const serialized = JSON.stringify(snapshot, null, 2)

  if (BRIDGE) {
    if (!fs.existsSync(GOLDEN_PATH)) { console.error('FATAL: no golden file'); process.exit(1) }
    const golden = fs.readFileSync(GOLDEN_PATH, 'utf8')
    const g = JSON.parse(golden)

    const surfaces = [...HAJJ_KEYS, 'hajjCatalogSection', 'orderedProgramNames']
    let diffs = 0
    console.log('\nSURFACE                      RESULT')
    console.log('-'.repeat(62))
    for (const k of surfaces) {
      const a = JSON.stringify(g[k]), b = JSON.stringify(snapshot[k])
      const same = a === b
      if (!same) diffs++
      console.log(`${k.padEnd(28)} ${same ? '✅ identical' : '❌ DIFFERS'}`)
      if (!same) {
        if (Array.isArray(g[k]) && Array.isArray(snapshot[k])) {
          if (g[k].length !== snapshot[k].length) console.log(`    length ${g[k].length} → ${snapshot[k].length}`)
          g[k].forEach((gv, i) => {
            if (gv !== snapshot[k][i]) {
              console.log(`    [${i}] golden: ${JSON.stringify(String(gv).slice(0, 160))}`)
              console.log(`    [${i}] bridge: ${JSON.stringify(String(snapshot[k][i]).slice(0, 160))}`)
            }
          })
        } else {
          const gs = String(g[k] ?? ''), bs = String(snapshot[k] ?? '')
          let i = 0; while (i < gs.length && i < bs.length && gs[i] === bs[i]) i++
          console.log(`    first difference at char ${i}`)
          console.log(`    golden: ${JSON.stringify(gs.slice(Math.max(0, i - 60), i + 100))}`)
          console.log(`    bridge: ${JSON.stringify(bs.slice(Math.max(0, i - 60), i + 100))}`)
        }
      }
    }

    // The number-reply contract, asserted explicitly (spec §5)
    const orderOk = JSON.stringify(g.orderedProgramNames) === JSON.stringify(snapshot.orderedProgramNames)
    console.log('\n── ORDERED ١…٩ (number-reply contract) ──')
    snapshot.orderedProgramNames.forEach((n, i) =>
      console.log(`  ${i + 1}. ${n}${n === g.orderedProgramNames[i] ? '' : `   ❌ golden: ${g.orderedProgramNames[i]}`}`))

    console.log(diffs === 0 && orderOk
      ? `\n✅ H4 PASS — all ${surfaces.length} surfaces byte-identical via the Offerings bridge.`
      : `\n❌ H4 FAIL — ${diffs} surface(s) differ. STOP.`)
    process.exit(diffs === 0 && orderOk ? 0 : 1)
  }

  if (CHECK) {
    if (!fs.existsSync(GOLDEN_PATH)) { console.error('FATAL: no golden file — run without --check first'); process.exit(1) }
    const golden = fs.readFileSync(GOLDEN_PATH, 'utf8')
    if (golden === serialized) { console.log('✅ IDENTICAL to golden baseline'); process.exit(0) }

    console.error('❌ DRIFT from golden baseline\n')
    const g = JSON.parse(golden)
    for (const k of [...HAJJ_KEYS, 'hajjCatalogSection', 'orderedProgramNames']) {
      const a = JSON.stringify(g[k]), b = JSON.stringify(snapshot[k])
      if (a !== b) {
        console.error(`  ${k}: DIFFERS`)
        if (Array.isArray(g[k]) && Array.isArray(snapshot[k]) && g[k].length !== snapshot[k].length)
          console.error(`    length ${g[k].length} → ${snapshot[k].length}`)
      }
    }
    process.exit(1)
  }

  fs.writeFileSync(GOLDEN_PATH, serialized)
  console.log(`Golden baseline written → ${GOLDEN_PATH}`)
  console.log(`  programs:        ${snapshot.hajjProgramDetails.length}`)
  console.log(`  overview chars:  ${snapshot.hajjOverviewMessage.length}`)
  console.log(`  economy/5star/kadan details: ${snapshot.hajjEconomyDetails.length}/${snapshot.hajjFiveStarDetails.length}/${snapshot.hajjKadanDetails.length}`)
  console.log(`  bytes:           ${serialized.length}`)
  console.log('\n  ordered ١…٩ (the number-reply contract):')
  snapshot.orderedProgramNames.forEach((n, i) => console.log(`    ${i + 1}. ${n}`))
})()
