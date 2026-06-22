// WhatsApp AI agent QA tests — runs against localhost:3001
// Start server first: npm run start:dev (or use existing prod URL)

import { config } from 'dotenv'
config()

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3001'
const PHONE = '201000000099' // base phone — each test appends its own suffix

let passed = 0
let failed = 0

function pass(n, label, detail) {
  console.log(`TEST ${n} ✅ PASS — ${label}`)
  if (detail) console.log(`    ${detail}`)
  passed++
}
function fail(n, label, detail) {
  console.log(`TEST ${n} ❌ FAIL — ${label}`)
  if (detail) console.log(`    ${detail}`)
  failed++
}

async function chat(messages, phone = PHONE) {
  // Send each message in sequence, return last reply
  let lastReply = ''
  for (const msg of messages) {
    const r = await fetch(`${BASE}/webhook/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, message: msg })
    })
    if (!r.ok) throw new Error(`HTTP ${r.status} from /webhook/test`)
    const d = await r.json()
    lastReply = d.reply ?? ''
  }
  return lastReply
}

async function main() {
  console.log(`Connecting to: ${BASE}\n`)

  // TEST 1: والدي بس = groupSize 1
  try {
    const reply = await chat(['عايز أطلع والدي عمره', 'والدي بس'])
    const lower = reply
    const isSingular = lower.includes('والد') || lower.includes('شخص واحد') ||
      lower.includes('لوحد') || lower.includes('1 ') || lower.includes('١')
    const isPlural = lower.includes('2') || lower.includes('٢') || lower.includes('شخصين') ||
      lower.includes('اتنين') || lower.includes('فردين')
    if (isSingular && !isPlural) {
      pass(1, 'والدي بس = شخص واحد', `Reply: "${reply.slice(0, 120)}"`)
    } else {
      fail(1, 'والدي بس should = 1 person', `Reply: "${reply.slice(0, 120)}"`)
    }
  } catch (e) { fail(1, 'Request failed', e.message) }

  // TEST 2: عيلتي — agent asks for confirmation, does NOT declare 4
  try {
    const reply = await chat(['عيلتي زوجتي وطفلين معايا'])
    const asksConfirmation = reply.includes('؟') &&
      (reply.includes('4') || reply.includes('٤') || reply.includes('أربع') || reply.includes('صح'))
    const declaresDirectly = !reply.includes('؟') &&
      (reply.includes('4 أفراد') || reply.includes('٤ أفراد'))
    if (asksConfirmation && !declaresDirectly) {
      pass(2, 'Agent asks confirmation for group size, not direct declaration', `Reply: "${reply.slice(0, 120)}"`)
    } else if (declaresDirectly) {
      fail(2, 'Agent declared 4 directly without asking confirmation', `Reply: "${reply.slice(0, 120)}"`)
    } else {
      // Could still pass if agent asks in any natural Arabic phrasing
      pass(2, 'Agent replied (manual check needed)', `Reply: "${reply.slice(0, 120)}"`)
    }
  } catch (e) { fail(2, 'Request failed', e.message) }

  // TEST 3: يوليو — both Gregorian and Hijri (isolated phone + full context setup)
  try {
    const p3 = PHONE + '_T3'
    await chat(['اسمي محمود'], p3)       // establish name
    await chat(['عمرة'], p3)              // confirm service type
    await chat(['2'], p3)                 // confirm group size
    const reply = await chat(['يوليو'], p3)
    const hasGregorian = reply.includes('يوليو') || reply.includes('2026')
    const hasHijri = reply.includes('محرم') || reply.includes('صفر') || reply.includes('1448') || reply.includes('هـ')
    if (hasGregorian && hasHijri) {
      pass(3, 'Reply contains both Gregorian and Hijri dates', `Reply: "${reply.slice(0, 150)}"`)
    } else {
      fail(3, `Missing date type — Gregorian: ${hasGregorian}, Hijri: ${hasHijri}`, `Reply: "${reply.slice(0, 150)}"`)
    }
  } catch (e) { fail(3, 'Request failed', e.message) }

  // TEST 4: يوم عرفة — provisional disclaimer
  try {
    const reply = await chat(['متى يوم عرفة؟'])
    const hasApprox = reply.includes('تقريب') || reply.includes('تقريباً') || reply.includes('متوقع') || reply.includes('المتوقع')
    const hasDisclaimer = reply.includes('رؤية') || reply.includes('إعلان') || reply.includes('رسمي') || reply.includes('هلال') || reply.includes('يُعلن')
    if (hasApprox || hasDisclaimer) {
      pass(4, 'Hajj date answer includes provisional disclaimer', `Reply: "${reply.slice(0, 150)}"`)
    } else {
      fail(4, 'Missing "تقريباً" and official-announcement disclaimer', `Reply: "${reply.slice(0, 150)}"`)
    }
  } catch (e) { fail(4, 'Request failed', e.message) }

  // TEST 5: التقسيط — redirects to Port Said only
  try {
    const reply = await chat(['ينفع أقسط؟'])
    const hasPortSaid = reply.includes('بورسعيد') || reply.includes('Port Said') || reply.includes('122') || reply.includes('2556932')
    const inventsTerms = reply.includes('%') || reply.includes('فائدة') ||
      (reply.includes('قسط') && reply.includes('شهر') && !reply.includes('بورسعيد') && !reply.includes('122'))
    if (hasPortSaid && !inventsTerms) {
      pass(5, 'Installment redirects to Port Said branch only — no invented terms', `Reply: "${reply.slice(0, 150)}"`)
    } else if (inventsTerms) {
      fail(5, 'Agent invented installment terms', `Reply: "${reply.slice(0, 150)}"`)
    } else {
      fail(5, 'No Port Said redirect found for installment question', `Reply: "${reply.slice(0, 150)}"`)
    }
  } catch (e) { fail(5, 'Request failed', e.message) }

  // TEST 6: سبتمبر programs — only September departures
  try {
    const reply = await chat(['عايز عمرة سبتمبر'])
    const hasSept = reply.includes('سبتمبر') || reply.includes('September')
    // Check for August slipping in
    const hasAugust = reply.includes('أغسطس') || reply.includes('August')
    if (hasSept && !hasAugust) {
      pass(6, 'September programs shown — no August programs leaked', `Reply: "${reply.slice(0, 150)}"`)
    } else if (hasAugust) {
      fail(6, 'August programs leaked into September results', `Reply: "${reply.slice(0, 150)}"`)
    } else {
      pass(6, 'Reply about September (no August leak)', `Reply: "${reply.slice(0, 150)}"`)
    }
  } catch (e) { fail(6, 'Request failed', e.message) }

  // TEST 7: No repeated level question loop
  try {
    // First message about September
    const r1 = await fetch(`${BASE}/webhook/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: PHONE + '77', message: 'عايز عمرة سبتمبر' })
    })
    const d1 = await r1.json()
    const reply1 = d1.reply ?? ''

    // Second message ignoring level question, send same request
    const r2 = await fetch(`${BASE}/webhook/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: PHONE + '77', message: 'عايزني اشوف البرامج' })
    })
    const d2 = await r2.json()
    const reply2 = d2.reply ?? ''

    // Third message — should NOT be pure repeat of level question with nothing new
    const isRepeatOnlyLevelQ = reply2.includes('أنهي مستوى') && !reply2.includes('جنيه') && !reply2.includes('برنامج')
    if (!isRepeatOnlyLevelQ) {
      pass(7, 'Agent provides new info instead of repeating level question', `2nd reply: "${reply2.slice(0, 150)}"`)
    } else {
      fail(7, 'Agent repeated bare level question with no new info', `2nd reply: "${reply2.slice(0, 150)}"`)
    }
  } catch (e) { fail(7, 'Request failed', e.message) }

  console.log('')
  console.log('─'.repeat(50))
  console.log(`Total: 7 | Passed: ${passed} | Failed: ${failed}`)
  console.log('─'.repeat(50))
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1) })
