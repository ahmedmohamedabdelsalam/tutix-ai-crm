import { arabicCount, DAYS, toArabicIndic } from '../utils/arabic-numerals'
import { fmtTripDay } from '../agent/prompts/dynamic-catalog-builder'

/**
 * Deterministic answers for catalog questions whose correct reply contains a number.
 *
 * The output guard rejects any model text containing a digit, so these can only be
 * answered in code — otherwise the customer gets a handoff (or, worse, a plausible
 * word-form claim the model invented, which the guard does not inspect).
 *
 * Every figure here is derived from offering rows. Nothing is hardcoded except the
 * definitional occupancy of a named room type (رباعي = four people), which is what
 * the word means rather than a fact about our inventory.
 */

const PERSONS = { one: 'فرد', two: 'فردين', few: 'أفراد', many: 'فرد' }

// ── 1. Room capacity ────────────────────────────────────────────────────────
// Which room types we actually sell comes from the data: a type is offered only
// when at least one live offering prices it.
const ROOM_TYPES: Array<{ key: string; label: string; capacity: number }> = [
  { key: 'quadPrice',   label: 'رباعي', capacity: 4 },
  { key: 'triplePrice', label: 'ثلاثي', capacity: 3 },
  { key: 'doublePrice', label: 'ثنائي', capacity: 2 },
]

export function buildRoomCapacityReply(rawPrograms: any[]): string | null {
  if (!rawPrograms?.length) return null
  const offered = ROOM_TYPES.filter(rt =>
    rawPrograms.some(p => typeof p?.[rt.key] === 'number' && p[rt.key] > 0))
  if (offered.length === 0) return null

  const lines = offered.map(rt => `· ${rt.label}: ${arabicCount(rt.capacity, PERSONS)}`)
  return `أنواع الغرف المتاحة يافندم:\n\n${lines.join('\n')}\n\nتحب أعرفلك أسعار أنهي نوع؟ 🤍`
}

// ── 2. Departure dates ──────────────────────────────────────────────────────
/**
 * Lists real upcoming departures instead of pivoting to "which duration?".
 * Dates come straight from the offering rows; only future departures are shown so
 * an expired trip is never offered.
 */
export function buildDepartureDatesReply(rawPrograms: any[], todayISO: string, limit = 8): string | null {
  if (!rawPrograms?.length) return null

  const byDep = new Map<string, { ret: string; days: number }>()
  for (const p of rawPrograms) {
    const dep = typeof p?.departureDate === 'string' ? p.departureDate : ''
    const ret = typeof p?.returnDate === 'string' ? p.returnDate : ''
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dep) || dep < todayISO) continue
    const days = ret
      ? Math.round((Date.parse(ret + 'T00:00:00Z') - Date.parse(dep + 'T00:00:00Z')) / 86400000) + 1
      : 0
    if (!byDep.has(dep)) byDep.set(dep, { ret, days })
  }
  if (byDep.size === 0) return null

  const rows = [...byDep.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(0, limit)
  const lines = rows.map(([dep, v], i) => {
    const span = v.ret ? ` — ${fmtTripDay(v.ret)}` : ''
    const dur  = v.days > 0 ? ` (${arabicCount(v.days, DAYS)})` : ''
    return `⭐ ${toArabicIndic(i + 1)}• ${fmtTripDay(dep)}${span}${dur}`
  })
  return `مواعيد السفر المتاحة يافندم:\n\n${lines.join('\n')}\n\nأنهي ميعاد مناسب مع حضرتك؟ 🤍`
}

// ── 3. Hajj duration ────────────────────────────────────────────────────────
const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩'
const toLatin = (s: string) => s.replace(/[٠-٩]/g, d => String(AR_DIGITS.indexOf(d)))
const HIJRI_MONTHS: Record<string, number> = {
  'يناير': 1, 'فبراير': 2, 'مارس': 3, 'أبريل': 4, 'مايو': 5, 'يونيو': 6,
  'يوليو': 7, 'أغسطس': 8, 'سبتمبر': 9, 'أكتوبر': 10, 'نوفمبر': 11, 'ديسمبر': 12,
}

/** "٧-١٠ مايو ٢٠٢٧م" → { startDay, endDay, month } — the shape hajj sections store. */
function parseRange(str?: string): { start: number; end: number; month: number } | null {
  if (!str) return null
  const s = toLatin(str)
  const monthEntry = Object.entries(HIJRI_MONTHS).find(([ar]) => str.includes(ar))
  if (!monthEntry) return null
  const m = s.match(/(\d{1,2})\s*-\s*(\d{1,2})/)
  if (m) return { start: parseInt(m[1], 10), end: parseInt(m[2], 10), month: monthEntry[1] }
  const one = s.match(/(\d{1,2})/)
  return one ? { start: parseInt(one[1], 10), end: parseInt(one[1], 10), month: monthEntry[1] } : null
}

/** Day span of one hajj program, from its earliest section start to its latest end. */
export function hajjProgramDays(p: any): number | null {
  const ranges = ['medina', 'aziziyah', 'makkahPreSeason', 'tahseen']
    .map(k => parseRange(p?.[k]?.dateGregorian))
    .filter(Boolean) as Array<{ start: number; end: number; month: number }>
  if (ranges.length === 0) return null
  const toOrd = (r: { start: number; month: number }) => r.month * 31 + r.start
  const toEnd = (r: { end: number; month: number }) => r.month * 31 + r.end
  const first = Math.min(...ranges.map(toOrd))
  const last  = Math.max(...ranges.map(toEnd))
  const days  = last - first + 1
  return days > 0 && days < 90 ? days : null
}

/**
 * Answers "how many days is hajj" with the real spread across programs, then asks
 * which category — instead of jumping straight to the category question.
 */
export function buildHajjDurationReply(hajjPrograms: any[], categoryQuestion?: string): string | null {
  if (!hajjPrograms?.length) return null
  const spans = hajjPrograms.map(hajjProgramDays).filter((d): d is number => d !== null)
  if (spans.length === 0) return null

  const min = Math.min(...spans), max = Math.max(...spans)
  const head = min === max
    ? `برامج الحج مدتها ${arabicCount(min, DAYS)} يافندم.`
    : `مدة برامج الحج بتتراوح من ${arabicCount(min, DAYS)} لـ ${arabicCount(max, DAYS)} حسب البرنامج يافندم.`
  const tail = categoryQuestion
    ? `\n\n${categoryQuestion}`
    : `\n\nتحب تعرف تفاصيل أنهي برنامج؟ 🤍`
  return `${head}${tail}`
}
