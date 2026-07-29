// ── Confidence router — routes 2, 3, 4 ───────────────────────────────────────
// Route 1 (CERTAIN)      = deterministic handlers already in whatsapp.service.ts.
// Route 2 (KNOWN ANSWER) = FAQ keyword match — verbatim answer, zero model involvement.
// Route 3 (CLARIFIER)    = code-built duration question (price-pivot in service).
// Route 4 (HANDOFF)      = blocked category | output-guard block | repeat failure.

// ── Blocked categories ───────────────────────────────────────────────────────
// Patterns are hardcoded; the admin enables/disables by name in
// CompanyAIConfig.templates.blockedCategories (string[]).
// If blockedCategories is absent or empty, ALL categories are active (safe default).
const CATEGORY_PATTERNS: Record<string, RegExp> = {
  discount:          /خصم|أرخص|تنزيل|أقل\s*سعر|آخر\s*سعر|ممكن\s*تنزّل|ينفع\s*أقل|تخفيض/,
  complaint:         /شكوى|شكاوى|(?:مشكلة|مشاكل)\s*(?:في|مع|كبيرة)|زعلان\s*من|غلط\s*في\s*(?:الحجز|الرحلة)/,
  refund:            /استرداد|فلوس\s*راجعة|استرجاع\s*(?:المبلغ|الفلوس)|إلغاء\s*الحجز|كنسلة|فسخ\s*الحجز/,
  payment:           /طرق\s*الدفع|بيدفع\s*إزاي|هدفع\s*إزاي|كريدت\s*كارد|بطاقة\s*ائتمانية|أوني\s*لاين\s*أدفع/,
  visa:              /تأشيرة|الفيزا\s*(?:المطلوبة|حجها|ليه|مدتها)|إجراءات\s*السفر|اوراق\s*الفيزا|مستندات\s*السفر/,
  medical:           /حالة\s*طبية|معاق|إعاقة|مريض\s*(?:بـ|ب)|أمراض\s*مزمنة|احتياجات\s*خاصة|وضع\s*صحي/,
  booking_commitment:/هحجز\s*دلوقتي|عايز\s*أحجز\s*الآن|خلاص\s*اتفقنا\s*على|ابعتلي\s*عقد|أكمل\s*الحجز/,
  large_group:       /(?:فوج|رحلة\s*جماعية)\s*(?:كبيرة?\s*)?(?:من|ل)?\s*(?:شركة|مدرسة|جهة)/,
}

export const DEFAULT_HANDOFF_INSIDE =
  'لحظة يافندم — زميلنا المختص هيرد عليك في أقرب وقت 🤍\n\nعندك سؤال تاني؟'

export const DEFAULT_HANDOFF_OUTSIDE =
  'يافندم شكراً لتواصلك 🤍\n\n' +
  'فريقنا غير متاح دلوقتي — هيتواصل معك أول ما يفتح الدوام إن شاء الله\n\n' +
  'ممكن تقولي اسمك وإيه اللي محتاج تعرفه بالتحديد؟'

// Route 2: code-based FAQ keyword match.
// Returns the verbatim admin-written answer, or null if no keyword matched.
export function matchFAQ(
  text: string,
  faqs: { question: string; answer: string; keywords?: any }[],
): string | null {
  for (const faq of faqs) {
    const kws: string[] | null = Array.isArray(faq.keywords) ? faq.keywords : null
    if (!kws || kws.length === 0) continue
    for (const kw of kws) {
      if (typeof kw === 'string' && kw.length > 0 && text.includes(kw)) return faq.answer
    }
  }
  return null
}

// Route 4a: detect whether the message belongs to a blocked category.
// enabledCategories comes from templates.blockedCategories.
export function detectBlockedCategory(
  text: string,
  enabledCategories?: string[],
): { matched: boolean; category?: string } {
  const active = enabledCategories?.length ? enabledCategories : Object.keys(CATEGORY_PATTERNS)
  for (const cat of active) {
    const pat = CATEGORY_PATTERNS[cat]
    if (pat && pat.test(text)) return { matched: true, category: cat }
  }
  return { matched: false }
}

// Build the time-aware handoff message from templates stored in CompanyAIConfig.templates.
// Expected shape:
//   workingHours: { start: "09:00", end: "21:00", timezone: "Africa/Cairo", days?: number[] }
//   handoffTemplateInsideHours:  string
//   handoffTemplateOutsideHours: string
export function buildHandoffMessage(templates: any): string {
  const wh = templates?.workingHours
  if (!wh?.start || !wh?.end || !wh?.timezone) {
    return templates?.handoffTemplateInsideHours ?? DEFAULT_HANDOFF_INSIDE
  }
  try {
    const nowInTz  = new Date(new Date().toLocaleString('en-US', { timeZone: wh.timezone }))
    const [sh, sm] = String(wh.start).split(':').map(Number)
    const [eh, em] = String(wh.end).split(':').map(Number)
    const nowMins  = nowInTz.getHours() * 60 + nowInTz.getMinutes()
    const startM   = sh * 60 + sm
    const endM     = eh * 60 + em
    const dayOk    = !wh.days || (wh.days as number[]).includes(nowInTz.getDay())
    const isOpen   = dayOk && nowMins >= startM && nowMins < endM
    return isOpen
      ? (templates?.handoffTemplateInsideHours  ?? DEFAULT_HANDOFF_INSIDE)
      : (templates?.handoffTemplateOutsideHours ?? DEFAULT_HANDOFF_OUTSIDE)
  } catch {
    return templates?.handoffTemplateInsideHours ?? DEFAULT_HANDOFF_INSIDE
  }
}
