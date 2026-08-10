import { arabicCount, DAYS } from '../utils/arabic-numerals'

/**
 * Deterministic answer for "are meals included?" — from the offering's own flags.
 *
 * WHAT WE ACTUALLY STORE is two booleans per programme: makkahBreakfast and
 * madinahBreakfast. That is all. We do not store a meal count, a meal plan, half
 * board, or what happens at lunch and dinner — so none of that may be stated.
 *
 * This replaces a blanket FAQ line ("كل البرامج شاملة الوجبات") that asserted every
 * programme includes meals. That claim contradicted the per-programme flags: a
 * programme whose madinahBreakfast is false was being told to customers as
 * all-inclusive. A fact the data disagrees with is worse than no fact.
 *
 * The reply therefore states breakfast per city and explicitly routes anything
 * else to the team, rather than inferring "so no other meals are included" — which
 * would be another claim we have no data for.
 */

export interface MealsCandidate {
  makkahHotel: string
  madinahHotel: string
  makkahBreakfast: boolean
  madinahBreakfast: boolean
  durationDays: number
}

const s = (v: unknown) => (typeof v === 'string' ? v : '')
const n = (v: unknown) => (typeof v === 'number' ? v : 0)
const b = (v: unknown) => v === true

export function toMealsCandidate(p: any): MealsCandidate {
  const mk = n(p.makkahNights ?? p.meccaNights)
  const md = n(p.madinahNights ?? p.medinaNights)
  return {
    makkahHotel: s(p.makkahHotel ?? p.meccaHotel),
    madinahHotel: s(p.madinahHotel ?? p.medinaHotel),
    makkahBreakfast: b(p.makkahBreakfast ?? p.meccaBreakfast),
    madinahBreakfast: b(p.madinahBreakfast ?? p.medinaBreakfast),
    durationDays: n(p.nights) > 0 ? n(p.nights) + 1 : mk + md + 1,
  }
}

/**
 * Distinct breakfast patterns. Two programmes with the same two flags give the same
 * answer, so they are not an ambiguity worth asking about — only a genuinely
 * different answer is.
 */
export function distinctMealPatterns(cands: MealsCandidate[]): MealsCandidate[] {
  const seen = new Map<string, MealsCandidate>()
  for (const c of cands) {
    if (!c.makkahHotel && !c.madinahHotel) continue
    const k = `${c.makkahBreakfast ? 1 : 0}|${c.madinahBreakfast ? 1 : 0}`
    if (!seen.has(k)) seen.set(k, c)
  }
  return [...seen.values()]
}

/**
 * Narrow to the programme(s) the customer means — same rule as the nights handler,
 * so "the programme in context" means one thing across the system: a hotel named
 * here or recently, then a duration named here or recently.
 */
export function narrowMealCandidates(
  text: string,
  historyText: string,
  rawPrograms: any[],
  detectDurationDays: (t: string) => number | null,
): MealsCandidate[] {
  let cands = (rawPrograms ?? []).map(toMealsCandidate).filter(c => c.makkahHotel || c.madinahHotel)
  if (cands.length === 0) return []

  const hotels = [...new Set(cands.flatMap(c => [c.makkahHotel, c.madinahHotel]).filter(Boolean))]
  const hotelHit = hotels.find(h => text.includes(h)) ?? hotels.find(h => historyText.includes(h))
  if (hotelHit) {
    const byHotel = cands.filter(c => c.makkahHotel === hotelHit || c.madinahHotel === hotelHit)
    if (byHotel.length) cands = byHotel
  }

  const dur = detectDurationDays(text) ?? detectDurationDays(historyText)
  if (dur !== null) {
    const byDur = cands.filter(c => c.durationDays === dur)
    if (byDur.length) cands = byDur
  }

  return cands
}

/**
 * The answer, or a narrowing question when programmes in context genuinely differ.
 * Returns null when there is nothing to answer from, so the caller falls through
 * rather than inventing a reply. Always ends with a question.
 */
export function buildMealsReply(cands: MealsCandidate[], availableDurations: number[]): string | null {
  const patterns = distinctMealPatterns(cands)
  if (patterns.length === 0) return null

  if (patterns.length === 1) {
    const c = patterns[0]
    const lines: string[] = []
    // Only cities the programme actually has a hotel in.
    if (c.makkahHotel) {
      lines.push(`· مكة المكرمة — ${c.makkahHotel}: ${c.makkahBreakfast ? 'شامل الإفطار' : 'من غير إفطار'}`)
    }
    if (c.madinahHotel) {
      lines.push(`· المدينة المنورة — ${c.madinahHotel}: ${c.madinahBreakfast ? 'شامل الإفطار' : 'من غير إفطار'}`)
    }
    if (lines.length === 0) return null
    return (
      `الوجبات المسجّلة عندنا في البرنامج ده يافندم:\n\n${lines.join('\n')}\n\n` +
      `ده اللي متسجّل عندنا عن الإفطار — لو حضرتك بتسأل عن وجبات تانية هأكدهالك من الفريق. ` +
      `تحب تعرف تفاصيل تانية عن البرنامج؟ 🤍`
    )
  }

  // Genuinely different answers in context — ask, using durations that exist.
  const opts = [...new Set(cands.map(c => c.durationDays).filter(d => d > 0))].sort((a, b2) => a - b2)
  const list = (opts.length ? opts : availableDurations ?? []).map(d => arabicCount(d, DAYS)).join(' / ')
  return list
    ? `الإفطار بيختلف من برنامج للتاني يافندم — متاح ${list}. أنهي برنامج اللي حضرتك بتسأل عنه؟`
    : `الإفطار بيختلف من برنامج للتاني يافندم — أنهي برنامج بتسأل عنه؟`
}
