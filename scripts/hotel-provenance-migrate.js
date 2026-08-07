/**
 * Give every hotel distance an owner.
 *
 * The distances in CompanyAIConfig.industryData.hotels are customer-facing factual
 * claims — HOTEL_DIST_HANDLER sends them verbatim, and because it is a
 * deterministic handler its output never passes scanModelOutput. Nobody recorded
 * where the numbers came from: no source comment, no data file, and no commit
 * message in the file's history names one. The only hint is that every entry
 * carries a booking.com / trivago / trip.com link.
 *
 * So this backfills provenance as 'unknown' — the honest value — which makes the
 * gap visible in the admin instead of invisible in a JSON blob, and lets the
 * handler refuse to state a distance nobody has confirmed.
 *
 * It also folds alias-only entries into the real hotel's keywords. Those rows are
 * misspellings masquerading as hotels: they carry no distance, so an alias match
 * returns an entry with nothing to say.
 *
 *   node scripts/hotel-provenance-migrate.js                 # DRY RUN
 *   node scripts/hotel-provenance-migrate.js --commit
 *   node scripts/hotel-provenance-migrate.js --company=<id> --commit
 *
 * Runs for one company at a time and is idempotent: entries that already carry
 * distanceSource are left exactly as they are, so re-running never overwrites a
 * confirmation Alex has made.
 */
'use strict'
const { Pool } = require('pg')
require('dotenv').config()

const arg = (n, d) => {
  const hit = process.argv.find(a => a.startsWith(`--${n}=`))
  return hit ? hit.slice(n.length + 3) : d
}
const COMPANY = arg('company', process.env.DEFAULT_COMPANY_ID)
const COMMIT = process.argv.includes('--commit')
if (!COMPANY) { console.error('FATAL: --company or DEFAULT_COMPANY_ID required'); process.exit(1) }

const pool = new Pool({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL })

/**
 * Normalise the confusion classes these aliases actually are — hamza forms, ة/ه,
 * ى/ي, and ذ/ز (شذا → شزا is the typo behind one of them). Doubled alifs collapse
 * too: رامادا → رامدا vs رمادا.
 */
const norm = s => String(s ?? '')
  .replace(/[أإآ]/g, 'ا').replace(/[ؤئء]/g, 'ي').replace(/ى/g, 'ي')
  .replace(/ة/g, 'ه').replace(/ذ/g, 'ز')
  .replace(/ا{2,}/g, 'ا')
  .replace(/\s+/g, ' ').trim()

/** Levenshtein similarity in [0,1]. */
function sim(a, b) {
  if (!a.length || !b.length) return 0
  if (a === b) return 1
  const prev = Array(b.length + 1).fill(0).map((_, i) => i)
  const cur = Array(b.length + 1).fill(0)
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j]
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length)
}

/**
 * An entry is alias-only when it has no distance of its own. Such a row can never
 * answer the question it would be matched for, so its name belongs in the keywords
 * of whichever real hotel it is a misspelling of.
 */
function findParent(alias, real) {
  const a = norm(alias.name)
  const aTokens = a.split(' ')
  let best = null, bestScore = 0
  for (const r of real) {
    const rn = norm(r.name)
    const rTokens = rn.split(' ')
    // Whole-name similarity, plus the mean of each alias token's best token match.
    // A short alias ("شزا") scores badly against a long name but perfectly against
    // its first token, which is exactly what a misspelling of that word is.
    const whole = sim(a, rn)
    const tokenwise = aTokens
      .map(at => Math.max(...rTokens.map(rt => sim(at, rt))))
      .reduce((x, y) => x + y, 0) / aTokens.length
    const score = Math.max(whole, tokenwise)
    if (score > bestScore) { bestScore = score; best = r }
  }
  return bestScore >= 0.7 ? { parent: best, score: bestScore } : { parent: null, score: bestScore }
}

;(async () => {
  const c = await pool.connect()
  try {
    const row = (await c.query(
      `SELECT id, "industryData" AS d FROM "CompanyAIConfig" WHERE "companyId"=$1`, [COMPANY])).rows[0]
    if (!row) throw new Error(`no CompanyAIConfig for company ${COMPANY}`)
    const data = row.d ?? {}
    const hotels = Array.isArray(data.hotels) ? data.hotels : []
    if (hotels.length === 0) { console.log('no hotels to migrate'); return }

    const real = hotels.filter(h => String(h.distance ?? '').trim() !== '')
    const aliasOnly = hotels.filter(h => String(h.distance ?? '').trim() === '')
    console.log(`${hotels.length} entries — ${real.length} with a distance, ${aliasOnly.length} alias-only\n`)

    // 1. provenance on the real entries
    console.log('PROVENANCE (backfilled as "unknown" — nobody recorded a source):')
    const next = real.map(h => {
      if (h.distanceSource) {
        console.log(`  = ${String(h.name).padEnd(20)} already ${h.distanceSource} — left untouched`)
        return h
      }
      console.log(`  + ${String(h.name).padEnd(20)} → unknown`)
      return {
        ...h,
        distanceSource: 'unknown',
        distanceConfirmedBy: null,
        distanceConfirmedAt: null,
      }
    })

    // 2. aliases folded into keywords
    console.log('\nALIASES → keywords:')
    let unmatched = 0
    for (const a of aliasOnly) {
      const { parent, score } = findParent(a, next)
      if (!parent) {
        unmatched++
        console.log(`  ⚠ ${String(a.name).padEnd(20)} no confident parent (best ${score.toFixed(2)}) — KEPT as its own entry`)
        continue
      }
      const kw = new Set([...(parent.keywords ?? []), ...(a.keywords ?? []), a.name])
      parent.keywords = [...kw]
      console.log(`  → ${String(a.name).padEnd(20)} folded into "${parent.name}" (${score.toFixed(2)}) — keywords now ${parent.keywords.length}`)
    }
    // An alias we could not place stays a row of its own: dropping it would lose a
    // spelling customers actually use, which is worse than a redundant entry.
    const keptAliases = aliasOnly.filter(a => !findParent(a, next).parent)
    const finalHotels = [...next, ...keptAliases]

    console.log(`\nresult: ${hotels.length} → ${finalHotels.length} entries (${aliasOnly.length - unmatched} aliases folded)`)
    const unknown = finalHotels.filter(h => h.distance && h.distanceSource === 'unknown').length
    console.log(`${unknown} distance(s) now marked unknown — the handler will not state these until confirmed.`)

    if (!COMMIT) { console.log('\nDRY RUN — re-run with --commit'); return }

    await c.query(`UPDATE "CompanyAIConfig" SET "industryData"=$2, "updatedAt"=now() WHERE id=$1`,
      [row.id, { ...data, hotels: finalHotels }])
    console.log('\n✅ committed')
  } catch (e) { console.error('❌', e.message); process.exitCode = 1 }
  finally { c.release(); await pool.end() }
})()
