import { arabicCount, NIGHTS, DAYS, toArabicIndic } from '../utils/arabic-numerals'

/**
 * Deterministic answer for "how many nights in Makkah / Madinah".
 *
 * Why this exists: the output guard rejects ANY model text containing a digit, so a
 * question whose correct answer is a number could only ever end in a handoff — the
 * model answers "٣ ليالي", the guard blocks it, the customer is told a colleague will
 * call. Answering in code returns before the model is ever called, so the guard never
 * sees it.
 *
 * All figures come from the offering rows (makkahNights / madinahNights); nothing is
 * inferred or hardcoded.
 */

export interface NightsCandidate {
  makkahNights:  number
  madinahNights: number
  makkahHotel:   string
  madinahHotel:  string
  durationDays:  number
}

const s = (v: unknown) => (typeof v === 'string' ? v : '')
const n = (v: unknown) => (typeof v === 'number' ? v : 0)

export function toCandidate(p: any): NightsCandidate {
  const mk = n(p.makkahNights ?? p.meccaNights)
  const md = n(p.madinahNights ?? p.medinaNights)
  return {
    makkahNights:  mk,
    madinahNights: md,
    makkahHotel:   s(p.makkahHotel ?? p.meccaHotel),
    madinahHotel:  s(p.madinahHotel ?? p.medinaHotel),
    durationDays:  n(p.nights) > 0 ? n(p.nights) + 1 : mk + md + 1,
  }
}

/** Distinct night splits among candidates — the thing that decides answer vs ask. */
export function distinctSplits(cands: NightsCandidate[]): NightsCandidate[] {
  const seen = new Map<string, NightsCandidate>()
  for (const c of cands) {
    if (c.makkahNights <= 0 && c.madinahNights <= 0) continue
    const k = `${c.makkahNights}|${c.madinahNights}`
    if (!seen.has(k)) seen.set(k, c)
  }
  return [...seen.values()]
}

/**
 * Narrows the catalog to the program(s) the customer means, using the current message
 * first and then recent conversation history — a customer who said "سبتمبر ٧ أيام" two
 * turns ago and now asks "كام يوم في مكة؟" means that program.
 */
export function narrowCandidates(
  text: string,
  historyText: string,
  rawPrograms: any[],
  detectDurationDays: (t: string) => number | null,
): NightsCandidate[] {
  let cands = (rawPrograms ?? []).map(toCandidate).filter(c => c.makkahNights > 0 || c.madinahNights > 0)
  if (cands.length === 0) return []

  // 1. Hotel named anywhere in the message or recent history
  const hotels = [...new Set(cands.flatMap(c => [c.makkahHotel, c.madinahHotel]).filter(Boolean))]
  const hotelHit = hotels.find(h => text.includes(h)) ?? hotels.find(h => historyText.includes(h))
  if (hotelHit) {
    const byHotel = cands.filter(c => c.makkahHotel === hotelHit || c.madinahHotel === hotelHit)
    if (byHotel.length) cands = byHotel
  }

  // 2. Duration stated in the message, else the most recent one in history
  const dur = detectDurationDays(text) ?? detectDurationDays(historyText)
  if (dur !== null) {
    const byDur = cands.filter(c => c.durationDays === dur)
    if (byDur.length) cands = byDur
  }

  return cands
}

/** The answer, or a narrowing question when the split is still ambiguous. Always ends with a question. */
export function buildNightsReply(cands: NightsCandidate[], availableDurations: number[]): string | null {
  const splits = distinctSplits(cands)
  if (splits.length === 0) return null

  if (splits.length === 1) {
    const c = splits[0]
    const parts: string[] = []
    if (c.madinahNights > 0) parts.push(`· المدينة المنورة: ${arabicCount(c.madinahNights, NIGHTS)}`)
    if (c.makkahNights  > 0) parts.push(`· مكة المكرمة: ${arabicCount(c.makkahNights, NIGHTS)}`)
    const total = c.durationDays > 0 ? `\n\nإجمالي البرنامج: ${arabicCount(c.durationDays, DAYS)}` : ''
    return `تقسيم الإقامة يافندم:\n\n${parts.join('\n')}${total}\n\nتحب تعرف تفاصيل تانية عن البرنامج؟ 🤍`
  }

  // Ambiguous — ask using the durations that genuinely exist, never invented options.
  const opts = [...new Set(cands.map(c => c.durationDays).filter(d => d > 0))].sort((a, b) => a - b)
  const list = (opts.length ? opts : availableDurations ?? [])
    .map(d => arabicCount(d, DAYS)).join(' / ')
  return list
    ? `تقسيم الليالي بيختلف حسب البرنامج يافندم — متاح ${list}. أنهي مدة اللي حضرتك بتسأل عنها؟`
    : `تقسيم الليالي بيختلف حسب البرنامج يافندم — أنهي برنامج بتسأل عنه؟`
}

/**
 * Recent CUSTOMER messages only, for context narrowing.
 *
 * Assistant text is deliberately excluded: a catalog overview lists every duration
 * we offer, so scanning it would "find" whichever appears first and silently answer
 * about the wrong program. Only what the customer actually said counts as context.
 */
export function historyTextOf(
  messages: Array<{ content?: string; role?: string }> | undefined,
  take = 12,
): string {
  if (!messages?.length) return ''
  return messages
    .filter(m => m?.role === 'USER')
    .slice(-take)
    .map(m => s(m.content))
    .join('\n')
}

export { toArabicIndic }
