// test-5fixes.js — validates all 5 real-conversation fixes
// Usage: node test-5fixes.js

const BASE = 'http://localhost:3001/webhook'
const PHONE_NAME  = '201111000001'   // Test 2: skip-name flow
const PHONE_MONTH = '201111000002'   // Test 3: month availability
const PHONE_HANDOFF = '201111000003' // Test 4: handoff dedup
const PHONE_PAY   = '201111000004'   // Test 6: payment guardrail

function pass(label) { console.log(`  ✅ PASS: ${label}`) }
function fail(label, got) { console.log(`  ❌ FAIL: ${label}`); console.log(`     Got: ${JSON.stringify(got).substring(0, 200)}`) }
function sep(title) { console.log(`\n${'─'.repeat(60)}\n  ${title}\n${'─'.repeat(60)}`) }

async function send(phone, message) {
  const r = await fetch(`${BASE}/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, message }),
  })
  const json = await r.json()
  const reply = json.reply ?? json.error ?? ''
  console.log(`  USER: ${message}`)
  console.log(`  AI  : ${reply.substring(0, 220)}`)
  return reply
}

async function sendMedia(phone, type) {
  const r = await fetch(`${BASE}/test-media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, type }),
  })
  const json = await r.json()
  console.log(`  MEDIA [${type}]: label="${json.label}" reply="${(json.reply ?? '').substring(0, 120)}"`)
  return json
}

async function clearData(phones) {
  // Delete test data via direct DB clear using a special endpoint — or just run fresh phones
  // Phones are unique per test, so they start fresh automatically on first message.
  // Just log what we're using.
  console.log(`\n  Test phones: ${phones.join(', ')}`)
  console.log('  (Fresh phones = clean state — no DB clear needed)')
}

async function run() {
  console.log('\n══════════════════════════════════════════════════')
  console.log('  TUTIX 5-FIXES TEST SUITE')
  console.log('══════════════════════════════════════════════════')

  await clearData([PHONE_NAME, PHONE_MONTH, PHONE_HANDOFF, PHONE_PAY])

  // ── TEST 1: Health check ────────────────────────────────────────────────────
  sep('TEST 1 — Health check')
  const h = await fetch(`${BASE}/health`).then(r => r.json())
  if (h.status === 'ok') pass('Server is running')
  else fail('Server health', h)

  // ── TEST 2: Mandatory name — skip → circle back ──────────────────────────
  sep('TEST 2 — Mandatory name collection (skip then circle back)')
  let r = await send(PHONE_NAME, 'السلام عليكم')
  if (/اسم|تشرفنا|حضرتك/.test(r)) pass('Greeted and asked for name')
  else fail('Did not ask for name on greeting', r)

  r = await send(PHONE_NAME, 'عايز اعرف تفاصيل العمرة')
  const hasInfoAndName = /اسم|تشرفنا/.test(r) || /يوليو|أغسطس|باكج|برنامج/.test(r)
  if (hasInfoAndName) pass('After skip: answered AND/OR circled back to name')
  else fail('No useful response after name skip', r)

  r = await send(PHONE_NAME, 'عمرة')
  const eventuallyAsksName = /اسم|تشرفنا|حضرتك/.test(r)
  if (eventuallyAsksName) pass('Agent circled back to ask for name within 3 messages')
  else {
    // Not a hard failure — agent may have answered first; check next turn
    console.log('  ℹ  Name not asked yet — checking next turn...')
    r = await send(PHONE_NAME, 'يوليو')
    if (/اسم|تشرفنا|حضرتك/.test(r)) pass('Agent circled back to ask for name by 4th message')
    else fail('Agent never circled back to ask for name', r)
  }

  // ── TEST 3: Month availability disclosure ───────────────────────────────────
  sep('TEST 3 — Proactive month/duration availability')
  r = await send(PHONE_MONTH, 'السلام عليكم')
  r = await send(PHONE_MONTH, 'محمد')
  r = await send(PHONE_MONTH, 'عايز اعمل عمرة في يوليو')

  const mentionsJulyDurations = /٧|١٠|١١|١٥/.test(r) && /يوليو/.test(r)
  if (mentionsJulyDurations) pass('July: agent listed available durations (7/10/11/15 days)')
  else fail('July durations not disclosed proactively', r)

  // Send August to also verify
  r = await send(PHONE_MONTH, 'أو أغسطس')
  const mentionsAugDurations = /٧|١١/.test(r) && /أغسطس/.test(r)
  if (mentionsAugDurations) pass('August: agent listed available durations (7/11 days)')
  else fail('August durations not disclosed proactively', r)

  // ── TEST 4: Handoff dedup — phone number only in first message ───────────────
  sep('TEST 4 — Single handoff message (phone not repeated)')
  // Build up to handoff by providing enough lead data
  await send(PHONE_HANDOFF, 'السلام عليكم')
  await send(PHONE_HANDOFF, 'أحمد')
  await send(PHONE_HANDOFF, 'عايز عمرة يوليو ٣ أشخاص')
  await send(PHONE_HANDOFF, 'أيوه ٣ أشخاص')

  // Explicitly request booking → should trigger handoff
  const handoff1 = await send(PHONE_HANDOFF, 'عايز احجز ٧ أيام باكج رمادا')
  const hasPhone1 = /01\d{9}|0\d{10}|\+20/.test(handoff1)
  if (/هحول|المختص|زميل/.test(handoff1)) pass('First handoff message sent')
  else fail('First handoff not triggered', handoff1)

  // Send another booking request — should NOT repeat phone
  const handoff2 = await send(PHONE_HANDOFF, 'عايز احجز')
  const hasPhone2 = /01\d{9}|0\d{10}|\+20/.test(handoff2)
  const isShortAck = /زميل|هيتواصل|أقرب وقت/.test(handoff2)
  if (!hasPhone2 && isShortAck) pass('Second handoff: NO phone number, short acknowledgment only')
  else if (hasPhone2) fail('Second handoff repeated phone number (should not!)', handoff2)
  else fail('Second handoff unexpected response', handoff2)

  // ── TEST 5: Differentiated media replies ────────────────────────────────────
  sep('TEST 5 — Differentiated media replies (image vs sticker)')
  const imgMedia = await sendMedia(PHONE_NAME, 'image')
  const stkMedia = await sendMedia(PHONE_NAME, 'sticker')

  if (imgMedia.label === '[صورة]') pass('Image: correct Arabic label [صورة]')
  else fail('Image label wrong', imgMedia.label)

  if (stkMedia.label === '[استيكر]') pass('Sticker: correct Arabic label [استيكر]')
  else fail('Sticker label wrong', stkMedia.label)

  if (imgMedia.reply !== stkMedia.reply) pass('Image and sticker have DIFFERENT replies')
  else fail('Image and sticker replies are identical (should be differentiated)', { img: imgMedia.reply, stk: stkMedia.reply })

  const paymentWordsImg = /حول|دفع|إيصال|بنك|فلوس/.test(imgMedia.reply)
  const paymentWordsStk = /حول|دفع|إيصال|بنك|فلوس/.test(stkMedia.reply)
  if (!paymentWordsImg && !paymentWordsStk) pass('Media replies contain NO payment-related words')
  else fail('Media replies contain payment words (should not)', { imgMedia: imgMedia.reply, stkMedia: stkMedia.reply })

  // ── TEST 6: Payment guardrail ────────────────────────────────────────────────
  sep('TEST 6 — Payment topic guardrail')
  await send(PHONE_PAY, 'السلام عليكم')
  await send(PHONE_PAY, 'سعيد')
  const payReply = await send(PHONE_PAY, 'حولت الفلوس وده الإيصال')

  const redirectsToAccounting = /حسابات|فريق/.test(payReply)
  const avoidsPaymentDetails = !/تأكيد|صورة|الإيصال|مبلغ|جنيه/.test(payReply)
  if (redirectsToAccounting) pass('Payment message: redirects to accounting team')
  else fail('Payment message: did not redirect to accounting', payReply)
  if (avoidsPaymentDetails) pass('Payment message: no payment details discussed')
  else fail('Payment message: discussed payment details (should not)', payReply)

  // ── SUMMARY ─────────────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════')
  console.log('  TEST SUITE COMPLETE')
  console.log('══════════════════════════════════════════════════\n')
}

run().catch(err => {
  console.error('Test suite error:', err.message)
  process.exit(1)
})
