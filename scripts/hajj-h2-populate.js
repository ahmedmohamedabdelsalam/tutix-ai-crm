/**
 * H2 — POPULATE HAJJ OFFERINGS ALONGSIDE
 *
 * Creates the "حج" OfferingType + 9 Offering rows from catalog.hajjPrograms,
 * per docs/hajj-offering-spec.md. NOTHING READS THESE ROWS — catalog-loader still
 * queries only name='عمرة'. This is purely additive.
 *
 * Guarantees:
 *   - catalog.hajjPrograms is NEVER written, modified or deleted.
 *   - No writes to Company.isActive / CompanyAIConfig.isActive / agentMode.
 *   - Idempotent: refuses to run twice unless --force replaces the previous rows.
 *
 *   node scripts/hajj-h2-populate.js              # DRY RUN (default) — writes nothing
 *   node scripts/hajj-h2-populate.js --commit     # perform the insert
 *   node scripts/hajj-h2-populate.js --verify     # round-trip equality report only
 *   node scripts/hajj-h2-populate.js --commit --force   # replace existing hajj rows
 */
'use strict'
const { Pool } = require('pg')
const { randomUUID } = require('crypto')
require('dotenv').config()

const COMPANY_ID = process.env.DEFAULT_COMPANY_ID
const COMMIT = process.argv.includes('--commit')
const FORCE  = process.argv.includes('--force')
const VERIFY = process.argv.includes('--verify')
if (!COMPANY_ID) { console.error('FATAL: DEFAULT_COMPANY_ID not set'); process.exit(1) }

// ── Spec §2.1 fieldDefs ──────────────────────────────────────────────────────
const FIELD_DEFS = [
  { key: 'id',                    label: 'المعرّف',                 role: null,               inputType: 'text',     required: true,  showInList: false },
  { key: 'name',                  label: 'اسم البرنامج',            role: 'title',            inputType: 'text',     required: true,  showInList: true  },
  { key: 'category',              label: 'الفئة',                   role: null,               inputType: 'text',     required: true,  showInList: true  },
  { key: 'pricePerPerson',        label: 'السعر للفرد',             role: 'price',            inputType: 'number',   required: false, showInList: true  },
  { key: 'discountedPrice',       label: 'السعر بعد الخصم',         role: 'price-discounted', inputType: 'number',   required: false, showInList: true  },
  { key: 'discountAmount',        label: 'قيمة الخصم',              role: null,               inputType: 'number',   required: false, showInList: false },
  { key: 'discountNote',          label: 'ملاحظة الخصم',            role: null,               inputType: 'text',     required: false, showInList: false },
  { key: 'startDateISO',          label: 'تاريخ البداية',           role: 'start-date',       inputType: 'date',     required: false, showInList: true  },
  { key: 'endDateISO',            label: 'تاريخ النهاية',           role: 'end-date',         inputType: 'date',     required: false, showInList: false },
  { key: 'ticketType',            label: 'نوع التذكرة',             role: null,               inputType: 'text',     required: true,  showInList: false },
  { key: 'transportationType',    label: 'نوع النقل',               role: null,               inputType: 'text',     required: true,  showInList: false },
  { key: 'haramainTrain',         label: 'قطار الحرمين',            role: null,               inputType: 'checkbox', required: false, showInList: false },
  { key: 'includesAirTicket',     label: 'التذكرة مشمولة',          role: 'flight-included',  inputType: 'checkbox', required: false, showInList: false },
  { key: 'medinaHotel',           label: 'فندق المدينة',            role: 'location',         inputType: 'text',     required: false, showInList: true  },
  { key: 'medinaDateHijri',       label: 'تاريخ المدينة (هجري)',    role: null,               inputType: 'text',     required: false, showInList: false },
  { key: 'medinaDateGregorian',   label: 'تاريخ المدينة (ميلادي)',  role: null,               inputType: 'text',     required: false, showInList: false },
  { key: 'aziziyahHotel',         label: 'فندق العزيزية',           role: 'location-2',       inputType: 'text',     required: false, showInList: false },
  { key: 'aziziyahDateHijri',     label: 'تاريخ العزيزية (هجري)',   role: null,               inputType: 'text',     required: false, showInList: false },
  { key: 'aziziyahDateGregorian', label: 'تاريخ العزيزية (ميلادي)', role: null,               inputType: 'text',     required: false, showInList: false },
  { key: 'makkahHotel',           label: 'فندق مكة',                role: 'location-3',       inputType: 'text',     required: false, showInList: false },
  { key: 'makkahDateHijri',       label: 'تاريخ مكة (هجري)',        role: null,               inputType: 'text',     required: false, showInList: false },
  { key: 'makkahDateGregorian',   label: 'تاريخ مكة (ميلادي)',      role: null,               inputType: 'text',     required: false, showInList: false },
  { key: 'tahseenHotel',          label: 'فندق التحسين',            role: 'location-4',       inputType: 'text',     required: false, showInList: false },
  { key: 'tahseenDateHijri',      label: 'تاريخ التحسين (هجري)',    role: null,               inputType: 'text',     required: false, showInList: false },
  { key: 'tahseenDateGregorian',  label: 'تاريخ التحسين (ميلادي)',  role: null,               inputType: 'text',     required: false, showInList: false },
]

// ── Arabic-Indic date parsing (spec §4) ──────────────────────────────────────
const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩'
const toLatin = s => String(s).replace(/[٠-٩]/g, d => String(AR_DIGITS.indexOf(d)))
const MONTHS = { 'يناير':1,'فبراير':2,'مارس':3,'أبريل':4,'مايو':5,'يونيو':6,'يوليو':7,'أغسطس':8,'سبتمبر':9,'أكتوبر':10,'نوفمبر':11,'ديسمبر':12 }

/** "٧-١٠ مايو ٢٠٢٧م" → { start: '2027-05-07', end: '2027-05-10' } */
function parseGregorianRange(str) {
  if (!str) return null
  const s = toLatin(str)
  const month = Object.entries(MONTHS).find(([ar]) => str.includes(ar))
  const year = (s.match(/(\d{4})/) || [])[1]
  if (!month || !year) return null
  const days = (s.match(/(\d{1,2})\s*-\s*(\d{1,2})/) || []).slice(1)
  const single = (s.match(/(\d{1,2})\s*[^\d]*\d{4}/) || [])[1]
  const mm = String(month[1]).padStart(2, '0')
  const iso = d => `${year}-${mm}-${String(d).padStart(2, '0')}`
  if (days.length === 2) return { start: iso(days[0]), end: iso(days[1]) }
  if (single) return { start: iso(single), end: iso(single) }
  return null
}

const SECTIONS = [
  ['medina',          'medina'],
  ['aziziyah',        'aziziyah'],
  ['makkahPreSeason', 'makkah'],
  ['tahseen',         'tahseen'],
]

/** Spec §3 — reproduces the runtime classification exactly. */
function classify(p) {
  if (!p.pricePerPerson) return 'special'
  const n = p.name || ''
  if (n.includes('كدانة')) return 'kadan'
  if (n.startsWith('برنامج ٥ نجوم') || n.startsWith('٥ نجوم') || n.includes('خمس نجوم')) return 'five_star'
  return 'economic'
}
const RANK = { economic: 0, five_star: 1, kadan: 2, special: 3 }

function buildValues(p, seasonBounds) {
  const v = {
    id: p.id, name: p.name,
    category: classify(p),
    pricePerPerson: p.pricePerPerson ?? null,
    discountedPrice: p.discountedPrice ?? null,
    discountAmount: p.discountAmount ?? null,
    discountNote: p.discountNote ?? null,
    ticketType: p.ticketType ?? '',
    transportationType: p.transportationType ?? '',
    haramainTrain: p.haramainTrain ?? false,
    includesAirTicket: p.includesAirTicket ?? false,
  }

  const sectionsJson = {}
  const starts = [], ends = []
  for (const [src, dst] of SECTIONS) {
    const sec = p[src]
    if (!sec) { v[`${dst}Hotel`] = ''; v[`${dst}DateHijri`] = ''; v[`${dst}DateGregorian`] = ''; continue }
    v[`${dst}Hotel`]         = sec.hotel ?? ''
    v[`${dst}DateHijri`]     = sec.dateHijri ?? ''
    v[`${dst}DateGregorian`] = sec.dateGregorian ?? ''
    const rest = {}
    for (const k of ['roomType', 'meals', 'note', 'durationDays']) if (sec[k] !== undefined) rest[k] = sec[k]
    sectionsJson[src] = rest
    const r = parseGregorianRange(sec.dateGregorian)
    if (r) { starts.push(r.start); ends.push(r.end) }
  }

  // §4 — derived; season-bounds fallback for the 3 section-less programs
  v.startDateISO = starts.length ? starts.sort()[0] : seasonBounds.start
  v.endDateISO   = ends.length   ? ends.sort().at(-1) : seasonBounds.end
  v._datesDerivedFrom = starts.length ? 'sections' : 'season-fallback'

  v.sectionsJson = sectionsJson
  v.contentJson = {
    highlights:     p.highlights ?? [],
    scholarNote:    p.scholarNote ?? null,
    subLevels:      p.subLevels ?? null,
    transitToMecca: p.transitToMecca ?? null,
    arafat:         p.arafat ?? null,
    mina:           p.mina ?? null,
    manasikhMeals:  p.manasikhMeals ?? null,
  }
  return v
}

/** Inverse of buildValues — used to prove round-trip equality. */
function reconstruct(v) {
  const p = {
    id: v.id, name: v.name,
    pricePerPerson: v.pricePerPerson,
    ticketType: v.ticketType,
    transportationType: v.transportationType,
    haramainTrain: v.haramainTrain,
    includesAirTicket: v.includesAirTicket,
    highlights: v.contentJson.highlights,
  }
  if (v.discountedPrice != null) p.discountedPrice = v.discountedPrice
  if (v.discountAmount  != null) p.discountAmount  = v.discountAmount
  if (v.discountNote    != null) p.discountNote    = v.discountNote
  for (const k of ['scholarNote', 'subLevels', 'transitToMecca', 'arafat', 'mina', 'manasikhMeals'])
    if (v.contentJson[k] != null) p[k] = v.contentJson[k]
  for (const [src, dst] of SECTIONS) {
    const hotel = v[`${dst}Hotel`]
    if (!hotel) continue                       // §2.3 presence rule
    p[src] = { hotel, dateHijri: v[`${dst}DateHijri`], dateGregorian: v[`${dst}DateGregorian`], ...(v.sectionsJson[src] || {}) }
  }
  return p
}

/** Deep compare ignoring key order; treats undefined and null as equal. */
function deepDiff(a, b, path = '', out = []) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})])
  for (const k of keys) {
    const av = a?.[k], bv = b?.[k], p = path ? `${path}.${k}` : k
    if (av == null && bv == null) continue
    if (Array.isArray(av) || Array.isArray(bv)) {
      if (JSON.stringify(av ?? []) !== JSON.stringify(bv ?? [])) out.push(p)
    } else if (typeof av === 'object' || typeof bv === 'object') {
      deepDiff(av || {}, bv || {}, p, out)
    } else if (av !== bv) out.push(`${p} (${JSON.stringify(av)} → ${JSON.stringify(bv)})`)
  }
  return out
}

const pool = new Pool({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL })

;(async () => {
  const c = await pool.connect()
  try {
    const cfg = await c.query(`SELECT "catalog","industryData" FROM "CompanyAIConfig" WHERE "companyId"=$1`, [COMPANY_ID])
    const hajj = cfg.rows[0].catalog.hajjPrograms || []
    const hijri = cfg.rows[0].industryData?.hajjHijriDates || []
    const first = parseGregorianRange(hijri[0]?.gregorian)
    const last  = parseGregorianRange(hijri.at(-1)?.gregorian)
    const seasonBounds = { start: first?.start ?? null, end: last?.end ?? null }
    console.log(`source programs: ${hajj.length} | season bounds: ${seasonBounds.start} … ${seasonBounds.end}\n`)

    // Rows are stored in SOURCE order — sortOrder = index in catalog.hajjPrograms.
    // The customer-facing ١…٩ grouping is computed inside the overview builders from
    // category+price; two surfaces render the raw array in source order, so storing
    // display order here would renumber them. See spec §5.
    const built = hajj.map(p => ({ src: p, values: buildValues(p, seasonBounds) }))
    const ordered = built

    // Display order shown for reference only — not persisted.
    const displayOrder = [...built].sort((a, b) =>
      (RANK[a.values.category] - RANK[b.values.category]) ||
      ((a.values.pricePerPerson ?? 0) - (b.values.pricePerPerson ?? 0)))

    console.log('stored in SOURCE order (sortOrder = catalog.hajjPrograms index):')
    console.log('#  cat        price    start        end          dates-from       name')
    console.log('-'.repeat(104))
    ordered.forEach((b, i) => {
      const v = b.values
      console.log(
        String(i + 1).padEnd(3),
        v.category.padEnd(10),
        String(v.pricePerPerson ?? '—').padEnd(8),
        String(v.startDateISO).padEnd(12),
        String(v.endDateISO).padEnd(12),
        v._datesDerivedFrom.padEnd(16),
        v.name)
    })

    console.log('\ncomputed DISPLAY order ١…٩ (applied inside the overview builders, not stored):')
    displayOrder.forEach((b, i) => console.log(`  ${i + 1}. ${b.values.name}`))

    // ── Round-trip equality ──────────────────────────────────────────────────
    console.log('\n── ROUND-TRIP EQUALITY (values → reconstructed vs source JSON) ──')
    let allEqual = true
    for (const b of built) {
      const diffs = deepDiff(b.src, reconstruct(b.values))
      if (diffs.length) { allEqual = false; console.log(`  ❌ ${b.src.name}`); diffs.forEach(d => console.log(`       ${d}`)) }
    }
    console.log(allEqual
      ? `  ✅ all ${built.length} programs reconstruct byte-identically from flattened values`
      : '  ❌ ROUND-TRIP FAILED — do not commit')
    if (!allEqual) process.exit(1)

    if (VERIFY) { console.log('\n(--verify: no writes)'); return }

    // ── Write ────────────────────────────────────────────────────────────────
    const existing = await c.query(
      `SELECT id FROM "OfferingType" WHERE "companyId"=$1 AND name='حج'`, [COMPANY_ID])
    if (existing.rows.length && !FORCE) {
      console.log('\nOfferingType "حج" already exists — nothing to do. Use --force to replace its rows.')
      return
    }

    if (!COMMIT) {
      console.log(`\nDRY RUN — would create OfferingType "حج" (${FIELD_DEFS.length} fieldDefs) + ${ordered.length} Offering rows.`)
      console.log('Nothing written. Re-run with --commit to apply.')
      console.log('\nSample values for program ١:')
      console.log(JSON.stringify(ordered[0].values, null, 2))
      return
    }

    await c.query('BEGIN')
    let typeId
    if (existing.rows.length) {
      typeId = existing.rows[0].id
      await c.query(`DELETE FROM "Offering" WHERE "companyId"=$1 AND "offeringTypeId"=$2`, [COMPANY_ID, typeId])
      await c.query(`UPDATE "OfferingType" SET "fieldDefs"=$1, "updatedAt"=now() WHERE id=$2`,
        [JSON.stringify(FIELD_DEFS), typeId])
      console.log(`\nReplaced rows on existing OfferingType ${typeId}`)
    } else {
      typeId = randomUUID().replace(/-/g, '')
      await c.query(
        `INSERT INTO "OfferingType" (id,"companyId",name,icon,"fieldDefs","isActive","createdAt","updatedAt")
         VALUES ($1,$2,'حج','🕋',$3,true,now(),now())`,
        [typeId, COMPANY_ID, JSON.stringify(FIELD_DEFS)])
      console.log(`\nCreated OfferingType "حج" id=${typeId}`)
    }

    for (let i = 0; i < ordered.length; i++) {
      const v = { ...ordered[i].values }
      delete v._datesDerivedFrom          // diagnostic only, not persisted
      await c.query(
        `INSERT INTO "Offering" (id,"companyId","offeringTypeId",values,"sortOrder","isActive","createdAt","updatedAt")
         VALUES ($1,$2,$3,$4,$5,true,now(),now())`,
        [randomUUID().replace(/-/g, ''), COMPANY_ID, typeId, JSON.stringify(v), i])
    }
    await c.query('COMMIT')
    console.log(`Inserted ${ordered.length} Offering rows (sortOrder 0…${ordered.length - 1}).`)
    console.log('catalog.hajjPrograms untouched. Nothing reads these rows yet.')
  } catch (e) {
    try { await c.query('ROLLBACK') } catch {}
    console.error('FAILED:', e.message); process.exitCode = 1
  } finally { c.release(); await pool.end() }
})()
