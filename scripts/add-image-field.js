/**
 * Declare an image field on an OfferingType.
 *
 * There is no fieldDefs editor in the admin UI — types are defined by script (see
 * hajj-h2-populate.js). This adds an `inputType: 'image'` field to any type of any
 * company, so it is the general tool, not a hajj/umrah one.
 *
 * The field's VALUE is always an array of image descriptors, written only by
 * /api/admin/offerings/[id]/images. The admin form deliberately never submits
 * image fields; the PATCH merge preserves them.
 *
 *   node scripts/add-image-field.js --type=عمرة                        # DRY RUN
 *   node scripts/add-image-field.js --type=عمرة --commit
 *   node scripts/add-image-field.js --type=حج --key=photos --label=صور --multiple --commit
 *   node scripts/add-image-field.js --type=عمرة --remove --commit      # undo
 *
 * Defaults: key=images, label=صور البرنامج, multiple=true.
 */
'use strict'
const { Pool } = require('pg')
require('dotenv').config()

const arg = (name, fallback) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const has = name => process.argv.includes(`--${name}`)

const COMPANY  = arg('company', process.env.DEFAULT_COMPANY_ID)
const TYPE     = arg('type', '')
const KEY      = arg('key', 'images')
const LABEL    = arg('label', 'صور البرنامج')
const MULTIPLE = has('multiple') || !has('single')
const REMOVE   = has('remove')
const COMMIT   = has('commit')

if (!COMPANY) { console.error('FATAL: --company or DEFAULT_COMPANY_ID required'); process.exit(1) }
if (!TYPE)    { console.error('FATAL: --type=<OfferingType name> required'); process.exit(1) }

const pool = new Pool({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL })

;(async () => {
  const c = await pool.connect()
  try {
    const t = (await c.query(
      `SELECT id, name, "fieldDefs" FROM "OfferingType" WHERE "companyId"=$1 AND name=$2`,
      [COMPANY, TYPE])).rows[0]
    if (!t) throw new Error(`no OfferingType named "${TYPE}" for company ${COMPANY}`)

    const defs = typeof t.fieldDefs === 'string' ? JSON.parse(t.fieldDefs) : t.fieldDefs
    const existing = defs.findIndex(d => d.key === KEY)
    console.log(`type "${t.name}" — ${defs.length} fieldDefs, "${KEY}" ${existing === -1 ? 'absent' : 'present'}`)

    let next
    if (REMOVE) {
      if (existing === -1) { console.log('nothing to remove'); return }
      next = defs.filter(d => d.key !== KEY)
      console.log(`would REMOVE the "${KEY}" field definition.`)
      console.log('NOTE: stored image descriptors in Offering.values are NOT deleted —')
      console.log('      the field simply stops rendering. Re-adding it brings them back.')
    } else {
      if (existing !== -1) { console.log('already declared — nothing to do'); return }
      const field = {
        key: KEY, label: LABEL, role: null,
        inputType: 'image', required: false, showInList: false,
        multiple: MULTIPLE,
      }
      next = [...defs, field]
      console.log(`would ADD: ${JSON.stringify(field)}`)
      const priceKeys = defs.filter(d => d.role && d.role.startsWith('price')).map(d => d.key)
      console.log(`price fields that will fingerprint its images: ${priceKeys.join(', ') || '(none — images can never be price-stale on this type)'}`)
    }

    // required:false and showInList:false are not cosmetic. A required image field
    // would block every save on rows that have no image yet, and the list column
    // would render descriptor objects as text.
    if (!COMMIT) { console.log('\nDRY RUN — re-run with --commit'); return }

    await c.query(`UPDATE "OfferingType" SET "fieldDefs"=$1, "updatedAt"=now() WHERE id=$2`,
      [JSON.stringify(next), t.id])
    console.log(`\n✅ committed — "${t.name}" now has ${next.length} fieldDefs`)
  } catch (e) { console.error('❌', e.message); process.exitCode = 1 }
  finally { c.release(); await pool.end() }
})()
