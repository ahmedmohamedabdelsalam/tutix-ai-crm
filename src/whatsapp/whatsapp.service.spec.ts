import { companionConfirmedInHistory, travelDateConfirmedInHistory } from './lead-fact-guards'

// triggerAIReply applies the same guards as handleMessage.
// freshMessages (last 10 from DB) is what both guards scan.
describe('dashboard triggerAIReply — stale-context guards', () => {
  it('conversation with no month/companion mention → guards block stale Lead facts', () => {
    // Simulates dashboard "send AI reply" for a lead whose Lead record has travelDate="أغسطس"
    // and companionNote from a prior session, but the current messages mention neither.
    const freshMessages = [
      { content: 'قولي برامج العمرة' },
      { content: 'تمام يافندم، أيه الوقت المناسب ليك؟' },
    ]
    expect(travelDateConfirmedInHistory(freshMessages)).toBe(false)   // stale month blocked
    expect(companionConfirmedInHistory(freshMessages)).toBe(false)    // stale companion blocked
  })
})

// Tests for the cross-session companion-leak fix.
//
// Bug: customer sends "قولي برامج العمرة" (no companion mention) →
// AI replies "معاك والدتك يعني شخصين" because Lead.companionNote from a
// prior session was injected as a "confirmed" fact in the current session.
//
// Fix: companionNote and groupSize from the Lead record are only carried
// into knownLeadFacts when the CURRENT conversation's own messages contain
// companion/group keywords (companionConfirmedInHistory returns true).

describe('companionConfirmedInHistory — cross-session companion leak guard', () => {

  it('TEST 1: blocks injection for a bare program request with no companion context', () => {
    // Fresh conversation — exactly the bug scenario.
    // The Lead may have companionNote from a past session, but the current
    // conversation has only this one message. Gate must return false so the
    // AI never sees stale companion data as "confirmed in this conversation".
    expect(companionConfirmedInHistory([])).toBe(false)
    expect(companionConfirmedInHistory([{ content: 'قولي برامج العمرة' }])).toBe(false)
    expect(companionConfirmedInHistory([{ content: 'عايز أعرف عن الأسعار' }])).toBe(false)
    // Even if Lead has old data and current conv grows without companion mention,
    // the gate continues to block:
    expect(companionConfirmedInHistory([
      { content: 'قولي برامج العمرة' },
      { content: 'تمام يافندم حضرتك بتسأل عن عمرة ولا حج؟' },
      { content: 'عمرة يوليو' },
    ])).toBe(false)
  })

  it('TEST 2: allows injection only when companion is genuinely mentioned in THIS session', () => {
    // Same phrase "قولي برامج العمرة" but the conversation history for THIS
    // session already has the customer confirming companion context. In this
    // case it is correct for the AI to know the group size.
    expect(companionConfirmedInHistory([
      { content: 'أنا ووالدتي عايزين نعمل عمرة' },
      { content: 'تمام يافندم كده حضرتك ووالدتك يعني ٢ أفراد إن شاء الله أنهي شهر؟' },
      { content: 'قولي برامج العمرة' },   // same trigger phrase — but companion already stated
    ])).toBe(true)

    expect(companionConfirmedInHistory([{ content: 'أنا وزوجتي بس' }])).toBe(true)
    expect(companionConfirmedInHistory([{ content: 'معايا ٣ أشخاص' }])).toBe(true)
    expect(companionConfirmedInHistory([{ content: 'مراتي هتيجي معايا' }])).toBe(true)
  })

})

describe('travelDateConfirmedInHistory — cross-session month leak guard', () => {

  it('TEST 1: bare program request with no month → gate returns false, stale month not injected', () => {
    // Exact bug scenario: customer sends "قولي برامج العمرة" with no month stated.
    // Lead.travelDate may hold "أغسطس" from a prior session — the gate must block it.
    expect(travelDateConfirmedInHistory([])).toBe(false)
    expect(travelDateConfirmedInHistory([{ content: 'قولي برامج العمرة' }])).toBe(false)
    expect(travelDateConfirmedInHistory([{ content: 'عايز أعرف عن الأسعار' }])).toBe(false)
    // Multi-turn conv with no month in any message must still return false:
    expect(travelDateConfirmedInHistory([
      { content: 'قولي برامج العمرة' },
      { content: 'تمام يافندم حضرتك بتسأل عن عمرة ولا حج؟' },
      { content: 'عمرة طبعاً' },
    ])).toBe(false)
  })

  it('TEST 2: month explicitly stated in this session → gate returns true, correct month used', () => {
    // When the customer actually names a month in this conversation, the gate must allow
    // Lead.travelDate through so the AI and bypass paths use the correct month.
    expect(travelDateConfirmedInHistory([{ content: 'عايز عمرة أغسطس' }])).toBe(true)
    expect(travelDateConfirmedInHistory([{ content: 'اغسطس' }])).toBe(true)
    expect(travelDateConfirmedInHistory([{ content: 'حاجز في يوليو' }])).toBe(true)
    expect(travelDateConfirmedInHistory([{ content: 'أي شهر أرخص؟' }])).toBe(true)
    // Month appears later in the conversation — gate sees the full history:
    expect(travelDateConfirmedInHistory([
      { content: 'قولي برامج العمرة' },
      { content: 'تمام حضرتك بتسأل عن عمرة أنهي شهر؟' },
      { content: 'أغسطس' },
    ])).toBe(true)
  })

})
