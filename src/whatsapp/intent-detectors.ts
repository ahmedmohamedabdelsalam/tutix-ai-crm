// Returns true when the customer's first message contains a real question or service intent,
// so the AI can send an immediate answer after the welcome instead of waiting for a name.
// "هل" uses a lookbehind to avoid matching inside greetings like "أهلاً".
export function containsFirstMessageQuestion(text: string): boolean {
  const QUESTION_SIGNALS = /عايز|محتاج|قولي|ممكن|أريد|اريد|كام|بكام|عندكم|فيه|ينفع|إيه|ايه|ما هو|(?<![ء-ي])هل|متى|فين|أسعار|اسعار|برامج|رحلة|رحلات|عروض|باقات/
  const SERVICE_SIGNALS  = /عمرة|حج|يوليو|أغسطس|سبتمبر|سعر|فندق|برنامج/
  return QUESTION_SIGNALS.test(text) || SERVICE_SIGNALS.test(text)
}

// Detects a specific umrah month in the customer message.
// Returns the Arabic month name as used in the month overview blocks (e.g. 'أغسطس').
// Covers all 12 months so unavailable-month handler fires for any future request.
export function detectUmrahMonth(text: string): string | null {
  if (/يولي[وو]|يوليو/.test(text)) return 'يوليو'
  if (/اغسطس|أغسطس/.test(text)) return 'أغسطس'
  if (/سبتمبر/.test(text)) return 'سبتمبر'
  if (/اكتوبر|أكتوبر/.test(text)) return 'أكتوبر'
  if (/نوفمبر/.test(text)) return 'نوفمبر'
  if (/ديسمبر|دسمبر/.test(text)) return 'ديسمبر'
  if (/يناير/.test(text)) return 'يناير'
  if (/فبراير/.test(text)) return 'فبراير'
  if (/مارس/.test(text)) return 'مارس'
  if (/ابريل|أبريل/.test(text)) return 'أبريل'
  if (/مايو/.test(text)) return 'مايو'
  if (/يونيو|يونيه/.test(text)) return 'يونيو'
  // Numeric month: "شهر ٨" / "شهر 8" — Arabic-Indic and Western digits, months 1–12
  const numericMatch = text.match(/شهر\s*([٠-٩0-9]{1,2})/)
  if (numericMatch) {
    const raw = numericMatch[1]
    const digit = parseInt(raw.replace(/[٠١٢٣٤٥٦٧٨٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))))
    const MONTH_NAMES = ['', 'يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
                             'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر']
    if (digit >= 1 && digit <= 12) return MONTH_NAMES[digit]
  }
  return null
}

// Detects the requested Umrah level from a customer message.
// "اقتصادي متميز" must be checked before "اقتصادي" (substring containment).
// فاخر maps to خمس نجوم — mirrors umrahProgramLevel() in dynamic-catalog-builder.
export function detectUmrahLevel(text: string): 'اقتصادي' | 'اقتصادي متميز' | 'خمس نجوم' | null {
  if (/اقتصادي\s*متميز/.test(text)) return 'اقتصادي متميز'
  if (/اقتصادي/.test(text)) return 'اقتصادي'
  if (/خمس\s*نجوم|٥\s*نجوم|5\s*نجوم|فاخر|فاخرة/.test(text)) return 'خمس نجوم'
  return null
}

// Extracts just the trip lines for a specific month from the monthOverviews block.
export function detectFullDetailsIntent(text: string): boolean {
  // Match requests for full program details even when modifier words are between keywords
  const hasAll = /كل/.test(text)
  const hasPrograms = /برامج|رحلات/.test(text)
  const hasDetails = /تفاصيل/.test(text)
  if (hasAll && hasPrograms && hasDetails) return true
  return /اعرضهم\s*كلهم|كله\s*بالتفص|تفاصيل\s*كل/.test(text)
}

export function detectContinueResponse(text: string): boolean {
  // \b doesn't work with Arabic (non-ASCII = \W). Use optional trailing content instead.
  return /^(كمل|اكمل|كمّل|ايوه|أيوه|اه|أه|آه|نعم|تمام|ماشي)(\s.*)?$/.test(text.trim())
}

export function detectHajjOverviewIntent(text: string): 'ECONOMY' | 'FIVE_STAR' | 'GENERIC' | null {
  // حج(?!ز) matches the pilgrimage noun ("حج", "الحج") but NOT the booking verb ("حجز", "أحجز", "يحجز").
  // Any match routes to the Hajj category question — no additional keyword required.
  if (!/حج(?!ز)/.test(text)) return null
  if (/اقتصادي|اقتصادية/.test(text)) return 'ECONOMY'
  if (/خمس\s*نجوم|٥\s*نجوم|5\s*نجوم|فاخر|فاخرة/.test(text)) return 'FIVE_STAR'
  return 'GENERIC'
}

/**
 * "How many days is hajj". Without this it matches the generic hajj intent and gets
 * the category question — technically correct content, but never an answer.
 */
export function detectHajjDurationIntent(text: string): boolean {
  if (!/حج(?!ز)/.test(text)) return false
  if (/(كام|كم)\s*(يوم|أيام|ايام|ليلة|ليالي)/.test(text)) return true
  return /مدة\s*(ال)?(حج|برنامج|رحلة)/.test(text)
}

export function detectHajjCategoryReply(text: string): 'ECONOMY' | 'FIVE_STAR' | 'KADAN' | null {
  const t = text.trim()
  if (/^[١1]$/.test(t)) return 'ECONOMY'
  if (/^[٢2]$/.test(t)) return 'FIVE_STAR'
  if (/^[٣3]$/.test(t)) return 'KADAN'
  if (/اقتصادي|اقتصادية/.test(t)) return 'ECONOMY'
  if (/خمس\s*نجوم|٥\s*نجوم|5\s*نجوم|فاخر|فاخرة/.test(t)) return 'FIVE_STAR'
  if (/كدانة/.test(t)) return 'KADAN'
  return null
}

export function detectScheduleIntent(text: string): boolean {
  return /مواعيد|جدول\s*الرحلة|برنامج\s*الرحلة|تفاصيل\s*الرحلة|تفاصيل\s*البرنامج|بتمشوا\s*امتى|موعد\s*السفر|الجدول\s*الزمني/.test(text)
}

export function detectFlightIntent(text: string): boolean {
  return /طيران|تذكرة\s*(?:ال)?طيران|الطيران|شامل[ةه]?\s*طيران|يشمل\s*(?:ال)?طيران|بتذكرة|بدون\s*طيران|الطيارة/.test(text)
}

export function detectInstallmentIntent(text: string): boolean {
  return /تقسيط|أقساط|اقساط|قسط|بالقسط|على\s*أقساط|على\s*اقساط|نقسط|دفعات/.test(text)
}

/**
 * "How many nights in Makkah / Madinah", "how many days is the trip", "how are the
 * nights split". The correct answer always contains a digit, which the output guard
 * blocks in model text — so this must be answered deterministically or it can only
 * ever end in a handoff.
 *
 * Requires an explicit كام/كم so a catalog filter like "عمرة ١٠ أيام" (a statement,
 * not a question) still routes to the duration bypass.
 */
export function detectNightsSplitIntent(text: string): boolean {
  const asksNights = /(كام|كم)\s*(ليلة|ليله|ليالي|ليال)/.test(text)
  if (asksNights) return true
  const asksDays = /(كام|كم)\s*(يوم|أيام|ايام)/.test(text)
  const placeCtx  = /مكة|مكه|المدينة|المدينه|الحرم|هناك|النبوي/.test(text)
  if (asksDays && placeCtx) return true
  if (/(تقسيم|توزيع)\s*(ال)?(ليالي|ليال|أيام|ايام|إقامة|اقامة)/.test(text)) return true
  return false
}

/**
 * "How many people fit in a quad room" — the answer is a number, so it must be
 * answered from code or the guard turns it into a handoff.
 */
export function detectRoomCapacityIntent(text: string): boolean {
  const roomWord = /غرفة|غرف|أوضة|اوضة|رباعي|ثلاثي|ثنائي|مزدوج|تسكين/.test(text)
  const asksCount = /(كام|كم)\s*(شخص|أشخاص|اشخاص|فرد|أفراد|افراد|نفر)/.test(text)
  if (roomWord && asksCount) return true
  // "الرباعي يعني كام؟" / "الغرفة تسع كام؟"
  if (roomWord && /(يعني|تسع|بتاخد|بتشيل)\s*(كام|كم)/.test(text)) return true
  return false
}

/**
 * "When do you travel / when does the trip leave" with no specific trip chosen.
 * Deserves the real departure dates rather than a pivot to "which duration?".
 * Excludes مواعيد, which already routes to the schedule handler.
 */
export function detectDepartureDatesIntent(text: string): boolean {
  const asksWhen = /(امتى|إمتى|متى|امتا)/.test(text)
  if (!asksWhen) return false
  return /(بتسافر|بتسافروا|السفر|بتقوم|بتقوموا|تقوم|الرحلة|الرحلات|المغادرة|بتمشي|بتمشوا)/.test(text)
}

/**
 * SPECIFICITY GUARD — the message asks something a dedicated handler answers, so a
 * month/duration word in it is a MODIFIER, not a request for the catalog.
 *
 * Single definition on purpose: this used to be inlined in the non-first-message
 * overview bypass only, so on a FIRST message "الطيران ايه في برامج سبتمبر؟" was
 * answered with a September catalog dump instead of the flight answer. Both bypasses
 * now call this, and test/gate/dispatch-order-suite.js holds them to it.
 */
export function hasSpecificHandlerIntent(text: string): boolean {
  return detectFlightIntent(text)
      || detectInstallmentIntent(text)
      || detectHotelDistanceIntent(text)
      || detectScheduleIntent(text)
      || detectNearestTripIntent(text)
      || detectNightsSplitIntent(text)
      || detectRoomCapacityIntent(text)
      || detectDepartureDatesIntent(text)
      || detectHotelContentIntent(text)
}

export function detectHotelDistanceIntent(text: string): boolean {
  // NOTE: \b is NOT used — Arabic chars are \W in JS, so \b after Arabic text is always dead.
  return /المسافة|قريب\s*(?:من)?|بعيد\s*(?:من)?|كام\s*(?:متر|دقيق)|كم\s*(?:متر|دقيق)|مشي\s*(?:كام|كم)|مشياً|من\s*الحرم|من\s*المسجد/.test(text)
}

export function detectUmrahOverviewIntent(text: string): boolean {
  return /عمرة|عمره/.test(text) && /برامج|رحلات|أسعار|اسعار|عروض|باقات|عندكم|عايز|محتاج|قولي/.test(text)
}

// Detects "nearest / next trip" queries: "أقرب رحلة عمرة امتى", "أول رحلة عمرة", "القادمة امتى"
export function detectNearestTripIntent(text: string): boolean {
  return /أقرب|اقرب|القادمة|القادم|الجاي|أول\s*رحلة|اول\s*رحلة/.test(text) && /عمرة|عمره|رحلة|سفر/.test(text)
}

// Hotel name/content query ("الفنادق ايه", "اسماء الفنادق", "فندق ايه ٥ نجوم").
// Must NOT fire on distance questions — hotel_dist handler owns those and is checked first.
// The exclusion here is a safety net; code ordering is the primary guard.
export function detectHotelContentIntent(text: string): boolean {
  if (/من\s*(?:الحرم|المسجد)|المسافة|كام\s*متر|كم\s*متر|مشياً/.test(text)) return false
  return /فنادق/.test(text)
    || /فندق/.test(text) && /اسم|أسماء|ايه|إيه|نجوم|اللي|بتاع|هي|ما\s*هي|كام|عندكم/.test(text)
}

// Detects Meta CTA button tap ("هل يمكنني الحصول على مزيد من المعلومات") or an
// ad-referral click with no specific service intent — both deserve the CTA menu reply.
export function detectCTAMessage(
  text: string,
  source?: string,
  referralData?: any,
): boolean {
  // Known CTA button phrase (exact phrase Meta sends on "Get More Info" tap)
  if (text.includes('هل يمكنني الحصول على مزيد من المعلومات')) return true
  // Ad referral with no meaningful specific intent
  const isAdReferral =
    source === 'ad' ||
    (referralData && (referralData.source_type === 'ad' || referralData.ctwa_clid))
  if (!isAdReferral) return false
  const hasSpecificIntent =
    /عمرة|حج(?!ز)|يولي[وو]|أغسطس|اغسطس|سبتمبر|أكتوبر|اكتوبر|نوفمبر|سعر|الأسعار|اسعار|فندق|برنامج/.test(text)
  return !hasSpecificIntent
}

// Extracts the requested trip duration in days from Arabic text.
// Handles Arabic-Indic numerals, Western digits, and common word-numbers.
export function detectDurationDays(text: string): number | null {
  // Arabic-Indic digits + يوم/أيام
  const arMatch = text.match(/([٠١٢٣٤٥٦٧٨٩]+)\s*(?:يوم|أيام|ايام)/)
  if (arMatch) {
    const n = parseInt(arMatch[1].split('').map(c => '٠١٢٣٤٥٦٧٨٩'.indexOf(c)).join(''))
    if (n > 0) return n
  }
  // Western digits + يوم/أيام
  const wMatch = text.match(/(\d+)\s*(?:يوم|أيام|ايام)/)
  if (wMatch) {
    const n = parseInt(wMatch[1])
    if (n > 0) return n
  }
  // Common word-numbers (longest match first to avoid partial hits)
  const WORDS: Array<[RegExp, number]> = [
    [/خمسة?\s*وعشرين|خمسة?\s*وعشرون/, 25],
    [/واحد\s*وعشرين|واحد\s*وعشرون/, 21],
    [/عشرين|عشرون/, 20],
    [/سبعة?\s*عشر|سبعطعش|سبعتعشر/, 17],
    [/خمسة?\s*عشر|خمسطعش|خمستعشر/, 15],
    [/أربعة?\s*عشر|اربعة?\s*عشر|أربعطعش|اربعطعش/, 14],
    [/اتناشر|اتناعشر|اثنا\s*عشر|اثني\s*عشر/, 12],
    [/عشرة|عشره/, 10],
    [/اسبوعين|أسبوعين/, 14],
    [/اسبوع|أسبوع/, 7],
  ]
  for (const [re, n] of WORDS) {
    if (re.test(text)) return n
  }
  return null
}

// Detects price-inquiry intent in any message.
// أرخص/الأرخص included: "cheapest program" is a price-comparison question (routed to price-pivot),
// not a discount request (that path was removed from the discount blocked-category).
export function detectPriceIntent(text: string): boolean {
  return /سعر|السعر|أسعار|الأسعار|اسعار|الاسعار|بكام|بقد\s*ايه|قد\s*ايه|تكلف|كلفة|تكاليف|تمن|ثمن|أرخص|الأرخص/.test(text)
}

export function detectNumberReply(text: string): number | null {
  const t = text.trim()
  // Arabic-Indic single digit ١-٩
  const arMatch = t.match(/^([١٢٣٤٥٦٧٨٩])$/)
  if (arMatch) return '١٢٣٤٥٦٧٨٩'.indexOf(arMatch[1]) + 1
  // Western single digit 1-9
  const numMatch = t.match(/^([1-9])$/)
  if (numMatch) return parseInt(numMatch[1])
  // "رقم ٦" or "رقم 6"
  const raqmMatch = t.match(/رقم\s*([١٢٣٤٥٦٧٨٩]|[1-9])/)
  if (raqmMatch) {
    const c = raqmMatch[1]
    return '١٢٣٤٥٦٧٨٩'.includes(c) ? '١٢٣٤٥٦٧٨٩'.indexOf(c) + 1 : parseInt(c)
  }
  // Ordinals
  const ordinals: Record<string, number> = {
    'الأول': 1, 'الثاني': 2, 'الثالث': 3, 'الرابع': 4,
    'الخامس': 5, 'السادس': 6, 'السابع': 7, 'الثامن': 8, 'التاسع': 9,
  }
  for (const [word, n] of Object.entries(ordinals)) {
    if (t.includes(word)) return n
  }
  return null
}

// Pure greeting with no service content.
// Returns false if ANY service/trip keyword is present so service handlers take priority.
export function detectGreetingOnly(text: string): boolean {
  const t = text.trim()
  if (/عايز|محتاج|سعر|فندق|حجز|عمرة|عمره|حج(?!ز)|برامج|رحلات|أسعار|اسعار|عروض|باقات|تفاصيل|مواعيد|طيران|تقسيط/.test(t)) return false
  return /^(السلام|وعليكم|أهلاً|اهلاً|اهلا|أهلا|مرحبا|مرحباً|صباح|مساء|هاي|هلو|ألو|الو|كيف|تمام\s*إيه|بخير)/.test(t)
    || (t.length <= 50 && /السلام|وعليكم|أهلاً|اهلاً|مرحبا/.test(t))
}

// Standalone Islamic phrase used as conversation filler (بسم الله, الحمد لله, etc.).
// Only fires when there are no service keywords in the same message.
export function detectReligiousPhrase(text: string): boolean {
  const t = text.trim()
  if (/عايز|محتاج|سعر|فندق|حجز|عمرة|عمره|حج(?!ز)|برامج/.test(t)) return false
  return t.length < 80
    && /^(بسم\s*الله|اللهم\s*صل|الحمد\s*لله|سبحان\s*الله|الله\s*أكبر|جزاك\s*الله|ربنا\s*يبارك|بارك\s*الله|آمين|أمين|ماشاء\s*الله|تبارك\s*الله|اللهم\s*بارك)/.test(t)
}

// Extracts a customer name from a message. Fires only when:
//   a) The text explicitly introduces a name ("أنا X" / "اسمي X"), OR
//   b) The previous assistant message asked for a name AND the reply is short, pure Arabic.
// Pass conv.messages (or any []) as the second argument for context-aware detection.
export function extractNameFromText(
  text: string,
  history: { role: string; content: string }[],
): string | null {
  const t = text.trim()
  if (t.length < 2 || t.length > 40) return null
  // Must be only Arabic letters and spaces — no digits, punctuation, or Latin
  if (!/^[؀-ۿ\s]+$/.test(t)) return null
  // Service/filler words → not a name
  if (/عايز|محتاج|سعر|فندق|حجز|عمرة|عمره|حج|برامج|رحلات|أسعار|عروض|باقات|تفاصيل|مواعيد|طيران|تقسيط|ممكن|عندكم|قولي|شكرا|شكراً|تمام|ماشي|حاضر|أيوه|ايوه|نعم|لأ|معلش|عادي|ممتاز|رائع|جميل|كويس|يعني|طيب|مافيش|صح|بالطبع|حبيبي|يسطا|ربنا|اللهم|سبحان|الحمد|إن\s*شاء|ماشاء/.test(t)) return null
  // Explicit introduction: "أنا / اسمي / مع حضرتك X"
  const intro = t.match(/^(?:أنا|انا|معك|مع\s*حضرتك|اسمي|اسمى|اسم\s*حضرتي)\s+([؀-ۿ\s]{2,25})$/)
  if (intro) return intro[1].trim()
  // Context-aware: previous assistant message asked for name → any short Arabic reply is a name
  const lastAsst = [...history].reverse().find(m => m.role === 'ASSISTANT' || m.role === 'assistant')
  const wasAskedForName = !!lastAsst
    && ['تشرفنا باسم', 'اسم حضرتك', 'باسم حضرتك', 'ممكن اعرف اسم', 'تقولي اسمك'].some(p => ((lastAsst as any).content ?? '').includes(p))
  if (wasAskedForName) {
    const words = t.split(/\s+/)
    if (words.length >= 1 && words.length <= 4 && words.every(w => w.length >= 2)) return t
  }
  return null
}

// Extracts an Egyptian or Gulf mobile number from text.
// Normalizes Arabic-Indic digits. Returns the number string or null.
export function extractPhoneNumber(text: string): string | null {
  const normalized = text.trim()
    .replace(/[٠١٢٣٤٥٦٧٨٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[\s\-]/g, '')
  // Egyptian 11-digit: 01xxxxxxxxxx
  let m = normalized.match(/(?:^|[^0-9])(01[0-9]{9})(?:[^0-9]|$)/)
  if (m) return m[1]
  // International Egyptian: +20 or 0020 prefix
  m = normalized.match(/(?:^|[^0-9])(?:\+|00)?20(1[0-9]{9})(?:[^0-9]|$)/)
  if (m) return '0' + m[1]
  // Saudi 10-digit: 05xxxxxxxx
  m = normalized.match(/(?:^|[^0-9])(05[0-9]{8})(?:[^0-9]|$)/)
  if (m) return m[1]
  // Saudi with +966
  m = normalized.match(/(?:^|[^0-9])(?:\+|00)?966(5[0-9]{8})(?:[^0-9]|$)/)
  if (m) return '0' + m[1]
  return null
}

// Detects a generic "show me all programs" request (no specific month or duration).
// Returns false for Hajj requests so they stay with the Hajj handler.
export function detectFullCatalogIntent(text: string): boolean {
  if (/حج(?!ز)/.test(text)) return false
  if (/كل\s*(?:ال)?برامج|كل\s*(?:ال)?رحلات|البرامج\s*كلها|الرحلات\s*كلها/.test(text)) return true
  if (/تفاصيل/.test(text) && /جميع/.test(text)) return true
  if (/ياريت\s*(?:ال)?تفاصيل/.test(text) && !/شهر|[٠-٩0-9]+\s*(?:يوم|أيام)/.test(text)) return true
  return false
}
