// Returns true when the customer's first message contains a real question or service intent,
// so the AI can send an immediate answer after the welcome instead of waiting for a name.
// "هل" uses a lookbehind to avoid matching inside greetings like "أهلاً".
export function containsFirstMessageQuestion(text: string): boolean {
  const QUESTION_SIGNALS = /عايز|محتاج|قولي|ممكن|أريد|اريد|كام|بكام|عندكم|فيه|ينفع|إيه|ايه|ما هو|(?<![ء-ي])هل|متى|فين|أسعار|اسعار|برامج|رحلة|رحلات/
  const SERVICE_SIGNALS  = /عمرة|حج|يوليو|أغسطس|سبتمبر|سعر|فندق|برنامج/
  return QUESTION_SIGNALS.test(text) || SERVICE_SIGNALS.test(text)
}

// Detects a specific umrah month in the customer message.
// Returns the Arabic month name as used in the month overview blocks (e.g. 'أغسطس').
export function detectUmrahMonth(text: string): string | null {
  if (/يولي[وو]|يوليو/.test(text)) return 'يوليو'
  if (/اغسطس|أغسطس/.test(text)) return 'أغسطس'
  if (/سبتمبر/.test(text)) return 'سبتمبر'
  if (/اكتوبر|أكتوبر/.test(text)) return 'أكتوبر'
  if (/نوفمبر/.test(text)) return 'نوفمبر'
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
  // Category word alone + حج is sufficient intent — no program-request keyword needed.
  if (/حج(?!ز)/.test(text)) {
    if (/اقتصادي|اقتصادية/.test(text)) return 'ECONOMY'
    if (/خمس\s*نجوم|٥\s*نجوم|5\s*نجوم|فاخر|فاخرة/.test(text)) return 'FIVE_STAR'
  }
  const isHajj =
    /برامج\s*الحج|أسعار\s*الحج|اسعار\s*الحج|برامج\s*حج|عن\s*برامج\s*الحج/.test(text) ||
    (/حج/.test(text) && /برامج|اسعار|أسعار|قولي|اعرض|عايز\s*اعرف/.test(text))
  if (!isHajj) return null
  if (/اقتصادي|اقتصادية/.test(text)) return 'ECONOMY'
  if (/خمس\s*نجوم|٥\s*نجوم|5\s*نجوم|فاخر|فاخرة/.test(text)) return 'FIVE_STAR'
  return 'GENERIC'
}

export function detectHajjCategoryReply(text: string): 'ECONOMY' | 'FIVE_STAR' | null {
  const t = text.trim()
  if (/^[١1]$/.test(t)) return 'ECONOMY'
  if (/^[٢2]$/.test(t)) return 'FIVE_STAR'
  if (/اقتصادي|اقتصادية/.test(t)) return 'ECONOMY'
  if (/خمس\s*نجوم|٥\s*نجوم|5\s*نجوم|فاخر|فاخرة/.test(t)) return 'FIVE_STAR'
  return null
}

export function detectUmrahOverviewIntent(text: string): boolean {
  return /عمرة/.test(text) && /برامج|رحلات|أسعار|اسعار|عندكم|عايز|محتاج|قولي/.test(text)
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
export function detectPriceIntent(text: string): boolean {
  return /سعر|السعر|أسعار|الأسعار|اسعار|الاسعار|بكام|بقد\s*ايه|قد\s*ايه|تكلف|كلفة|تكاليف|تمن|ثمن/.test(text)
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
