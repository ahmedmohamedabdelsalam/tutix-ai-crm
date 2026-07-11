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

export function detectHajjOverviewIntent(text: string): boolean {
  return /برامج\s*الحج|أسعار\s*الحج|اسعار\s*الحج|برامج\s*حج|عن\s*برامج\s*الحج/.test(text) ||
    (/حج/.test(text) && /برامج|اسعار|أسعار|قولي|اعرض|عايز\s*اعرف/.test(text))
}

export function detectUmrahOverviewIntent(text: string): boolean {
  return /عمرة/.test(text) && /برامج|رحلات|أسعار|اسعار|عندكم|عايز|محتاج|قولي/.test(text)
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
