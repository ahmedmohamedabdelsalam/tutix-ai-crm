import { companionConfirmedInHistory } from './whatsapp.service'

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
