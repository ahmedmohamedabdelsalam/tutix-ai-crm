/**
 * Adds a CompanyFAQ entry — the right home for facts that are NOT in our data.
 *
 * Why FAQ rather than a handler: child-age policy and baggage allowance have no
 * column anywhere in the schema, so a handler would have to invent the number. A FAQ
 * answer is written by a human, stored verbatim, and returned verbatim by
 * matchFAQ() at whatsapp.service.ts — before the model is ever called, so neither the
 * model nor the output guard is involved.
 *
 * Matching is plain substring over `keywords`. Keep keywords SPECIFIC: a short one
 * like "سن" would fire inside سنة/حسن and hijack unrelated questions.
 *
 *   node scripts/add-faq.js --key child-age --answer "..."            # dry run
 *   node scripts/add-faq.js --key child-age --answer "..." --commit
 *   node scripts/add-faq.js --list
 */
'use strict'
const { Pool } = require('pg')
const { randomUUID } = require('crypto')
require('dotenv').config()

const COMPANY = process.env.DEFAULT_COMPANY_ID
if (!COMPANY) { console.error('FATAL: DEFAULT_COMPANY_ID not set'); process.exit(1) }

const argv = process.argv.slice(2)
const arg  = n => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : undefined }
const has  = n => argv.includes('--' + n)

// Keyword sets for the two gaps the guard audit surfaced. Deliberately specific.
const PRESETS = {
  'child-age': {
    question: 'ما هي سياسة الأطفال والسن؟',
    keywords: ['الطفل', 'الاطفال', 'الأطفال', 'اطفالي', 'أطفالي', 'الرضيع', 'رضيع', 'سن الطفل', 'عمر الطفل'],
  },
  'baggage': {
    question: 'كم وزن الأمتعة المسموح؟',
    keywords: ['شنطة', 'الشنطة', 'شنط', 'الشنط', 'الأمتعة', 'الامتعة', 'وزن العفش', 'كام كيلو'],
  },
}

const pool = new Pool({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL })

;(async () => {
  const c = await pool.connect()
  try {
    if (has('list')) {
      const rows = (await c.query(
        `SELECT id, question, "isActive", keywords FROM "CompanyFAQ" WHERE "companyId"=$1 ORDER BY "createdAt"`,
        [COMPANY])).rows
      console.log(`${rows.length} FAQ entries:`)
      rows.forEach(r => console.log(`  [${r.isActive ? 'on ' : 'off'}] ${r.question}\n        keywords=${JSON.stringify(r.keywords)}`))
      return
    }

    const key = arg('key')
    const answer = arg('answer')
    const preset = PRESETS[key]
    if (!preset) {
      console.error(`--key must be one of: ${Object.keys(PRESETS).join(', ')}`)
      process.exit(1)
    }
    if (!answer || answer.trim().length < 10) {
      console.error('--answer is required (the human-written text returned verbatim to customers)')
      process.exit(1)
    }

    // Warn on keywords that would collide with existing FAQ entries
    const existing = (await c.query(`SELECT question, keywords FROM "CompanyFAQ" WHERE "companyId"=$1 AND "isActive"=true`, [COMPANY])).rows
    const clashes = []
    for (const e of existing) {
      const kws = Array.isArray(e.keywords) ? e.keywords : []
      for (const k of kws) if (preset.keywords.some(n => n.includes(k) || k.includes(n))) clashes.push(`${k} (in "${e.question}")`)
    }
    if (clashes.length) console.warn(`⚠ keyword overlap with existing FAQs: ${[...new Set(clashes)].join(', ')}`)

    console.log(`question : ${preset.question}`)
    console.log(`keywords : ${preset.keywords.join(', ')}`)
    console.log(`answer   : ${answer}`)

    if (!has('commit')) {
      console.log('\nDRY RUN — nothing written. Re-run with --commit to insert.')
      return
    }
    await c.query(
      `INSERT INTO "CompanyFAQ" (id,"companyId",question,answer,keywords,"isActive","createdAt","updatedAt")
       VALUES ($1,$2,$3,$4,$5,true,now(),now())`,
      [randomUUID().replace(/-/g, ''), COMPANY, preset.question, answer.trim(), JSON.stringify(preset.keywords)])
    console.log('\n✅ inserted. Note: the FAQ cache is 10 minutes — restart the service or wait for it to expire.')
  } finally { c.release(); await pool.end() }
})()
