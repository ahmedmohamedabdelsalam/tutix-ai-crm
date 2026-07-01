/**
 * Catalog structure validation + live Railway AI test (3 scenarios)
 * Run after: npm run build
 */
import { buildHajjCatalog, buildHajjFAQ, buildHajjGeneralKnowledge } from './dist/src/agent/prompts/hajj-packages.js'
import https from 'https'

// ── Section 1: Catalog structure ─────────────────────────────────────────────
const catalog = buildHajjCatalog()

const EXPECTED_PROGRAMS = [
  { name: 'برنامج الحج البري',              price: '٢٣٩٬٠٠٠',  hotels: ['أوديست', 'مواسم الخير', 'موفنبيك هاجر'] },
  { name: 'حج اقتصادي - تحسين ٥ نجوم',    price: '٢٥٥٬٠٠٠',  hotels: ['أوديست', 'نزل البشاير', 'موفنبيك هاجر'] },
  { name: 'أطول فترة تحسين ١٤ يوم',        price: '٢٦٢٬٠٠٠',  hotels: ['زمزم', 'أوديست'] },
  { name: '٥ نجوم أ',                       price: '٥٢٠٬٠٠٠',  hotels: ['الحارثية', 'موفنبيك هاجر'] },
  { name: 'اقتصادي أطول فترة تحسين',       price: 'غير محدد', hotels: ['زمزم', 'أوديست'] },
  { name: '٥ نجوم ب',                       price: '٤٩٥٬٠٠٠',  hotels: ['إعمار رويال', 'هيلتون مؤتمرات'] },
  { name: 'كدانة - المستوى الكامل',         price: '٦٥٠٬٠٠٠',  hotels: ['الحارثية', 'موفنبيك هاجر', 'كدانة'] },
  { name: 'كدانة - مستوى سريع',            price: '٥٩٥٬٠٠٠',  hotels: ['الحارثية', 'موفنبيك هاجر', 'كدانة'] },
  { name: 'اقتصادي تحسين',                 price: 'غير محدد', hotels: ['زمزم', 'أوديست'] },
]

const EXPECTED_DATES = ['٢٠ ذو القعدة', '١٣ ذو الحجة', '١٧ ذو الحجة', '٢٠ ذو الحجة']
const REQUIRED_TERMS = ['تقريباً', 'بدون تذكرة الطيران', 'بدون تذكرة العبّارة', 'غير محدد', 'المبيعات']

let allPass = true
function pass(s) { console.log(`  ✓  ${s}`) }
function fail(s) { console.log(`  ✗  ${s}`); allPass = false }

console.log('\n═══════════════════════════════════════════════════════')
console.log('  STRUCTURE CHECK: buildHajjCatalog()')
console.log('═══════════════════════════════════════════════════════')

// Count programs
const progCount = (catalog.match(/^\[/gm) || []).length
progCount === 9 ? pass(`9 program blocks found`) : fail(`Expected 9 programs, found ${progCount}`)

// Check each program
for (const p of EXPECTED_PROGRAMS) {
  const inCatalog = catalog.includes(p.price) && (p.price === 'غير محدد' ? catalog.includes('غير محدد') : true)
  const hotelsOk = p.hotels.every(h => catalog.includes(h))
  inCatalog ? pass(`${p.name}: price ${p.price} present`) : fail(`${p.name}: price ${p.price} MISSING`)
  hotelsOk  ? pass(`${p.name}: hotels [${p.hotels.join(', ')}] present`) : fail(`${p.name}: some hotel MISSING — checked: ${p.hotels.join(', ')}`)
}

// Date table entries
for (const d of EXPECTED_DATES) {
  catalog.includes(d) ? pass(`Date entry "${d}" in table`) : fail(`Date entry "${d}" MISSING`)
}

// Required terms
for (const t of REQUIRED_TERMS) {
  catalog.includes(t) ? pass(`Required term "${t}" present`) : fail(`Required term "${t}" MISSING`)
}

// Disclaimer rule present
catalog.includes('يُعلن رسمياً بعد رؤية الهلال') ? pass('Hijri date disclaimer rule present') : fail('Hijri date disclaimer rule MISSING')
catalog.includes('٩ برامج') || catalog.includes('الـ٩ برامج') ? pass('9-program sell rule present') : fail('Update: sell rule still says old count — check selling instructions')

console.log('\n═══════════════════════════════════════════════════════')
console.log('  CATALOG PRINTOUT (trimmed to first 3000 chars)')
console.log('═══════════════════════════════════════════════════════')
console.log(catalog.slice(0, 3000))

// ── Section 2: Live Railway AI tests ─────────────────────────────────────────
const RAILWAY_HOST = 'tutix-ai-crm-production.up.railway.app'

function post(message) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ phone: '201099990001', message })
    const req = https.request(
      { hostname: RAILWAY_HOST, port: 443, path: '/webhook/test', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let body = ''
        res.on('data', c => body += c)
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(body) }) }
          catch { resolve({ status: res.statusCode, body }) }
        })
      }
    )
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

const TESTS = [
  {
    label: 'MSG 1: عايز أعرف برامج الحج',
    msg:   'عايز أعرف برامج الحج',
    checks: [
      r => ({ ok: r.includes('البري') || r.includes('٢٣٩'),       label: 'mentions البري or 239,000' }),
      r => ({ ok: r.includes('اقتصادي') || r.includes('٢٥٥'),     label: 'mentions اقتصادي or 255,000' }),
      r => ({ ok: r.includes('كدانة') || r.includes('٦٥٠'),        label: 'mentions كدانة or 650,000' }),
      r => ({ ok: r.includes('بدون تذكرة') || r.includes('بدون'), label: 'includes بدون تذكرة disclaimer' }),
    ],
  },
  {
    label: 'MSG 2: إيه الفرق بين برنامج الحج البري و5 نجوم أ',
    msg:   'إيه الفرق بين برنامج الحج البري و5 نجوم أ؟',
    checks: [
      r => ({ ok: r.includes('٢٣٩') || r.includes('٢٣٩٬٠٠٠'),   label: 'mentions البري price 239,000' }),
      r => ({ ok: r.includes('٥٢٠') || r.includes('٥٢٠٬٠٠٠'),   label: 'mentions 5-star-A price 520,000' }),
      r => ({ ok: r.includes('باص') || r.includes('عبّارة') || r.includes('بري'), label: 'mentions باص or عبارة transport distinction' }),
    ],
  },
  {
    label: 'MSG 3: السعر الأرخص كام؟',
    msg:   'السعر الأرخص كام؟',
    checks: [
      r => ({ ok: r.includes('٢٣٩') || r.includes('٢٣٩٬٠٠٠'), label: 'says 239,000 (cheapest = البري)' }),
      r => ({ ok: r.includes('البري') || r.includes('بري'),      label: 'names البري program' }),
    ],
  },
]

console.log('\n═══════════════════════════════════════════════════════')
console.log('  LIVE AI VALIDATION (Railway production)')
console.log(`  ⚠  Note: if Railway hasn't redeployed yet, AI may use OLD catalog`)
console.log('═══════════════════════════════════════════════════════')

for (const t of TESTS) {
  console.log(`\n──────────────────────────────────────────────────────`)
  console.log(`  ${t.label}`)
  console.log('──────────────────────────────────────────────────────')
  try {
    const { status, body } = await post(t.msg)
    const reply = typeof body === 'object' ? (body.reply || JSON.stringify(body)) : body
    console.log(`  HTTP: ${status}`)
    console.log(`  AI reply:\n${reply.split('\n').map(l => '    ' + l).join('\n')}`)
    for (const chk of t.checks) {
      const { ok, label } = chk(reply)
      ok ? pass(label) : fail(label)
    }
  } catch (e) {
    fail(`Request failed: ${e.message}`)
  }
  // small gap between requests
  await new Promise(r => setTimeout(r, 1500))
}

console.log('\n═══════════════════════════════════════════════════════')
console.log(allPass ? '  ALL CHECKS PASSED ✓' : '  SOME CHECKS FAILED ✗ — review failures above')
console.log('═══════════════════════════════════════════════════════\n')
process.exit(allPass ? 0 : 1)
