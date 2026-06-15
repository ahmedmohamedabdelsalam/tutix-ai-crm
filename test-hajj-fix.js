require('dotenv').config()
const { Pool } = require('pg')
const pool = new Pool({ connectionString: process.env.DATABASE_URL })

const BASE = 'http://localhost:3001'
const COMPANY_ID = process.env.DEFAULT_COMPANY_ID
const PHONE = '20109999001'

async function post(msg) {
  const res = await fetch(`${BASE}/webhook/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: PHONE, message: msg }),
  })
  const j = await res.json()
  return j.reply ?? j.replies?.join('\n') ?? JSON.stringify(j)
}

async function clear() {
  await pool.query(`DELETE FROM "Message" WHERE "conversationId" IN (SELECT id FROM "Conversation" WHERE phone = $1 AND "companyId" = $2)`, [PHONE, COMPANY_ID])
  await pool.query(`DELETE FROM "Conversation" WHERE phone = $1 AND "companyId" = $2`, [PHONE, COMPANY_ID])
  await pool.query(`DELETE FROM "Lead" WHERE phone = $1 AND "companyId" = $2`, [PHONE, COMPANY_ID])
}

async function main() {
  await clear()
  console.log('[CLEAR] Test data cleared\n')

  const CONVERSATION = [
    'السلام عليكم',
    'أحمد',
    'عايز اعرف عن نظام الحج',
    'حج',
  ]

  for (const msg of CONVERSATION) {
    const reply = await post(msg)
    console.log(`USER : ${msg}`)
    console.log(`AGENT: ${reply}`)
    console.log()
  }

  // Audits
  console.log('=== AUDIT ===')
  const responses = []
  // Re-run just the Hajj messages to capture replies for analysis
  await clear()
  await post('السلام عليكم')
  await post('أحمد')
  const r3 = await post('عايز اعرف عن نظام الحج')
  const r4 = await post('حج')

  const FORBIDDEN_PATTERNS = [
    /\d{10,}/,                        // any 10+ digit number (phone numbers)
    /فريق متخصص/,
    /اتصل عليه/,
    /تواصل مع/,
    /1191/,                           // the specific leaked ID prefix
  ]

  let pass = true
  for (const [label, reply] of [['Hajj question', r3], ['Hajj confirm', r4]]) {
    const issues = FORBIDDEN_PATTERNS.filter(p => p.test(reply)).map(p => p.toString())
    if (issues.length) {
      console.log(`FAIL [${label}]: found forbidden patterns: ${issues.join(', ')}`)
      console.log(`  Reply: ${reply}`)
      pass = false
    } else {
      console.log(`PASS [${label}]: no forbidden patterns`)
      console.log(`  Reply: ${reply}`)
    }
  }

  // Check that "عمرة" is mentioned as the offering
  const mentionsUmrah = /عمرة/.test(r3) || /عمرة/.test(r4)
  if (mentionsUmrah) console.log('PASS: mentions Umrah as the available offering')
  else { console.log('WARN: did not explicitly mention Umrah'); pass = false }

  console.log(pass ? '\n✅ ALL CHECKS PASS' : '\n❌ SOME CHECKS FAILED')

  await pool.end()
}
main().catch(e => { console.error(e); pool.end() })
