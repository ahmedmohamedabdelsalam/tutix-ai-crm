// Proves three \b-near-Arabic bugs found in the systemic audit (2026-07-31).
// JavaScript's \b is ASCII-only: Arabic chars are \W, so \b between Arabic and space
// is \W↔\W — never a word boundary. Each test shows: OLD=dead/broken, NEW=correct.

// ─── 1. detectHotelDistanceIntent — `من\s*المسجد\b` was DEAD ──────────────────
describe('detectHotelDistanceIntent — من\s*المسجد', () => {
  const OLD = /المسافة|قريب\s*(?:من)?|بعيد\s*(?:من)?|كام\s*(?:متر|دقيق)|كم\s*(?:متر|دقيق)|مشي\s*(?:كام|كم)|مشياً|من\s*الحرم|من\s*المسجد\b/
  const NEW = /المسافة|قريب\s*(?:من)?|بعيد\s*(?:من)?|كام\s*(?:متر|دقيق)|كم\s*(?:متر|دقيق)|مشي\s*(?:كام|كم)|مشياً|من\s*الحرم|من\s*المسجد/

  const ONLY_MASJID = 'الفندق من المسجد النبوي طيب؟'

  it('OLD: من\s*المسجد\b is dead — never matches because \\b after Arabic is \\W↔\\W', () => {
    expect(OLD.test(ONLY_MASJID)).toBe(false)
  })

  it('NEW: من\s*المسجد without \\b matches correctly', () => {
    expect(NEW.test(ONLY_MASJID)).toBe(true)
  })

  it('NEW: still matches الحرم alternative', () => {
    expect(NEW.test('الفندق من الحرم بعيد؟')).toBe(true)
  })

  it('NEW: still matches explicit distance words', () => {
    expect(NEW.test('كام متر من الفندق')).toBe(true)
    expect(NEW.test('مشي كام دقيقة')).toBe(true)
  })
})

// ─── 2. whatsapp.service.ts:330 — `/\bحج\b/` was DEAD ────────────────────────
describe('Hajj packageType detection — /\\bحج\\b/ vs /حج(?!ز)/', () => {
  const OLD = /\bحج\b/
  const NEW = /حج(?!ز)/

  const HAJJ_INTENT   = 'عايز أعمل حج هالسنة'
  const BOOKING_VERB  = 'عايز أحجز رحلة عمرة'
  const HAJJ_WORD_END = 'رحلة الحج'

  it('OLD: \\bحج\\b is dead — misses clear Hajj intent', () => {
    expect(OLD.test(HAJJ_INTENT)).toBe(false)
  })

  it('NEW: /حج(?!ز)/ correctly detects Hajj intent', () => {
    expect(NEW.test(HAJJ_INTENT)).toBe(true)
  })

  it('NEW: /حج(?!ز)/ does NOT fire on booking verb "حجز"', () => {
    expect(NEW.test(BOOKING_VERB)).toBe(false)
  })

  it('NEW: /حج(?!ز)/ matches "الحج" at end of string', () => {
    expect(NEW.test(HAJJ_WORD_END)).toBe(true)
  })

  it('OLD: \\bحج\\b is also dead at end of string', () => {
    expect(OLD.test(HAJJ_WORD_END)).toBe(false)
  })
})

// ─── 3. cleanAgentResponse — `/^للعمرة[\s\W]*$/` was PARTIALLY BROKEN ─────────
describe('cleanAgentResponse preamble strip — للعمرة', () => {
  // \W matches Arabic chars, so the old pattern over-strips real content lines
  const OLD = /^للعمرة[\s\W]*$/
  const NEW = /^للعمرة[^؀-ۿ]*$/

  const REAL_CONTENT = 'للعمرة والمدينة المنورة'
  const PREAMBLE_BARE = 'للعمرة'
  const PREAMBLE_COLON = 'للعمرة:'
  const PREAMBLE_EMOJI = 'للعمرة 🕌'

  it('OLD: incorrectly strips real content line (Arabic after للعمرة is \\W)', () => {
    expect(OLD.test(REAL_CONTENT)).toBe(true)  // BUG: strips "للعمرة والمدينة المنورة"
  })

  it('NEW: correctly keeps real content line', () => {
    expect(NEW.test(REAL_CONTENT)).toBe(false)
  })

  it('OLD and NEW both strip bare preamble', () => {
    expect(OLD.test(PREAMBLE_BARE)).toBe(true)
    expect(NEW.test(PREAMBLE_BARE)).toBe(true)
  })

  it('OLD and NEW both strip preamble + colon', () => {
    expect(OLD.test(PREAMBLE_COLON)).toBe(true)
    expect(NEW.test(PREAMBLE_COLON)).toBe(true)
  })

  it('OLD and NEW both strip preamble + emoji', () => {
    expect(OLD.test(PREAMBLE_EMOJI)).toBe(true)
    expect(NEW.test(PREAMBLE_EMOJI)).toBe(true)
  })
})
