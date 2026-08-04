import { OverviewState, RawTrip } from './conversation-state'

/**
 * Recovery for lost conversation state.
 *
 * overviewMap / fullDetailsMap / categoryQuestionMap live in process memory, so a
 * deploy (several a day) or a map eviction wipes them mid-conversation. Before
 * this module a customer who then replied "٣" hit no handler at all and got
 * silence — the failure only ever showed up in production.
 *
 * Rather than persisting the state, we re-derive it from the assistant messages
 * already loaded on the conversation (take: -30). No new queries.
 *
 * The hard constraint: a bare number is NOT always a menu choice. "٤" is often
 * "four people" during lead capture. Recovery therefore fires ONLY when the recent
 * history shows we actually sent an overview or a category question. In every other
 * case the message falls through exactly as before.
 */

// ── Structural markers ───────────────────────────────────────────────────────
// Overviews number their entries with a star bullet: "⭐ ١• ..." (both umrah trip
// cards and hajj category listings). The category question uses the same numbering
// WITHOUT the star, which is what separates the two.
const OVERVIEW_MARKER = /⭐\s*[١٢٣٤٥٦٧٨٩]•/
const CATEGORY_MARKER = /[١٢٣٤٥٦٧٨٩]•\s*\*(البرامج الاقتصادية|برامج خمس نجوم|أبراج كدانة)\*/
// Non-final full-details chunk ends with "... — أكملك الباقي؟"; the final one says
// "كده عرضتلك كل البرامج" and needs no resume.
const CHUNK_UNFINISHED_MARKER = /أكملك الباقي/

export const looksLikeOverview         = (t: string) => OVERVIEW_MARKER.test(t)
export const looksLikeCategoryQuestion = (t: string) => CATEGORY_MARKER.test(t)
export const looksLikeUnfinishedChunk  = (t: string) => CHUNK_UNFINISHED_MARKER.test(t)

export interface HistoryMessage { role: string; content: string }

/**
 * Most recent ASSISTANT message satisfying `pred`, scanning back at most `lookback`
 * assistant messages. Bounded so an overview from far earlier in a long conversation
 * cannot resurrect itself.
 */
export function lastAssistantMatching(
  messages: HistoryMessage[] | undefined,
  pred: (text: string) => boolean,
  // An overview occupies several rows once split, so the window must be wide enough
  // to see past its own trailing parts — but still bounded, so an overview from far
  // earlier in a long conversation cannot resurrect itself.
  lookback = 8,
): string | null {
  if (!messages?.length) return null
  let seen = 0
  for (let i = messages.length - 1; i >= 0 && seen < lookback; i--) {
    const m = messages[i]
    if (m?.role !== 'ASSISTANT') continue
    seen++
    const c = String(m.content ?? '')
    if (pred(c)) return c
  }
  return null
}

/**
 * The numbered entry lines ("⭐ ١• ...") of an overview.
 *
 * These are matched rather than the title because persistReply runs the reply
 * through splitIntoMessages, so history stores an overview as SEVERAL rows — the
 * one carrying the star bullets is usually not the one carrying the title.
 *
 * They are also price-stable: for umrah the star line holds dates + duration, for
 * hajj it holds the program name. Prices sit on the following line, so an admin
 * price edit between the two turns does not break the match.
 */
function markerLines(text: string): string[] {
  return text.split('\n').map(l => l.trim()).filter(l => OVERVIEW_MARKER.test(l))
}

/**
 * Works out WHICH catalog overview a previously-sent message was, by matching its
 * title against the current catalog. Titles ("*رحلات عمرة ١٠ أيام*") stay stable when
 * prices change, so this survives an admin edit between the two messages.
 *
 * Returns the CURRENT version of that overview plus its ordered details, so the
 * re-sent list and the numbering the customer replies against cannot disagree.
 */
export function identifyOverview(
  previousText: string,
  catalog: any,
): { message: string; state: OverviewState } | null {
  if (!catalog) return null
  const wanted = markerLines(previousText)
  if (wanted.length === 0) return null

  const candidates: Array<{ message: string; details: string[]; rawTrips?: RawTrip[] }> = []

  const push = (message?: string, details?: string[]) => {
    if (message && details?.length) candidates.push({ message, details })
  }

  push(catalog.umrahAllMonthsMessage, catalog.umrahAllMonthsDetails)
  for (const k of Object.keys(catalog.umrahMonthMessages ?? {})) {
    push(catalog.umrahMonthMessages[k], catalog.umrahMonthDetails?.[k])
  }
  for (const k of Object.keys(catalog.umrahDurationMessages ?? {})) {
    push(catalog.umrahDurationMessages[k], catalog.umrahDurationDetails?.[k])
  }
  push(catalog.hajjEconomyPrograms,  catalog.hajjEconomyDetails)
  push(catalog.hajjFiveStarPrograms, catalog.hajjFiveStarDetails)
  push(catalog.hajjKadanPrograms,    catalog.hajjKadanDetails)

  // A candidate matches when it still contains the exact entry line the customer saw.
  const hit = candidates.find(c => wanted.some(w => c.message.includes(w)))
  if (!hit) return null
  return { message: hit.message, state: { orderedDetails: hit.details, rawTrips: hit.rawTrips } }
}

// ── Recovery copy (company-configurable) ─────────────────────────────────────
// Defaults are fallbacks for an unconfigured tenant, mirroring buildHandoffMessage.
const DEFAULT_OVERVIEW_RESEND = 'اتفضل البرامج تاني يافندم 🤍'
const DEFAULT_CATEGORY_RESEND = 'اتفضل الأقسام تاني يافندم 🤍'
const DEFAULT_CHUNK_RESUME    = 'معلش يافندم، تحب أعرضلك البرامج من الأول؟'

export function recoveryText(templates: any, kind: 'overview' | 'category' | 'chunk'): string {
  const t = templates?.recoveryTemplates
  if (kind === 'overview') return t?.overviewResend ?? DEFAULT_OVERVIEW_RESEND
  if (kind === 'category') return t?.categoryResend ?? DEFAULT_CATEGORY_RESEND
  return t?.chunkResume ?? DEFAULT_CHUNK_RESUME
}
