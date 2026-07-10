import { ARABIC_INDIC, CAIRO_OFFSET_MS } from '../utils/arabic-numerals'

function parseDaysFromText(text: string): number | null {
  if (/بكر[هة]|يوم واحد/.test(text)) return 1
  if (/يومين/.test(text)) return 2
  if (/أسبوعين/.test(text)) return 14
  if (/الأسبوع الجاي|بعد أسبوع|في أسبوع/.test(text)) return 7
  const m = text.match(/([٠١٢٣٤٥٦٧٨٩]+|[0-9]+)\s*(?:أيام?|يوم)/)
  if (m) {
    const n = parseInt(m[1].split('').map(c => { const i = ARABIC_INDIC.indexOf(c); return i >= 0 ? String(i) : c }).join(''))
    if (!isNaN(n) && n >= 1 && n <= 30) return n
  }
  return null
}

function isFollowUpProposal(msg: string): boolean {
  // Agent message contains "بكرة" + a contact-intent verb → it was a follow-up proposal
  return /بكر[هة]/.test(msg) &&
    /أتواصل|هتواصل|هأتواصل|هاتواصل|هكلمك|أكلمك|هرد عليك/.test(msg)
}

const HARD_DECLINE = [
  'أنا هكلمك', 'أنا اللي هكلمك', 'هكلمك أنا', 'متتصلش', 'بلاش تتصل', 'بلاش تكلمني',
]
// Words that indicate the customer is deferring / asking to be called back
const DEFER_INTENT = /هفكر|بفكر|خليني افكر|هرد عليك|رد عليا|كلمني|تواصل معي|بعد كده/

const AGREEMENT = ['ماشي', 'تمام', 'أيوه', 'أوكي', 'اوكي', 'موافق', 'أكيد', 'اكيد', 'حاضر']

const SHORT_WAIT = /دقيقة|لحظة|ثانية|ثواني|شوية|كمان شوية/
const REAL_DURATION = /يوم|أيام|بكر[هة]|أسبوع|شهر/

export const DEFERRAL_PHRASES = [
  'هتأكد مع الفريق', 'فريقنا هيتابع', 'الأفضل الرجوع لـ',
  'مش متاكد', 'مش متأكد', 'هتأكدلك', 'هتأكد لك', 'هتأكد للحضرتك',
]

export function detectFollowUpIntent(
  text: string,
  history: { role: string; content: string }[],
): { shouldSchedule: boolean; days: number; declined: boolean } {
  const t = text.trim()

  // Hard decline: customer refuses to be contacted
  if (HARD_DECLINE.some(kw => t.includes(kw))) {
    return { shouldSchedule: false, days: 0, declined: true }
  }

  // Short-wait filler phrases ("دقيقة"/"لحظة"/"شوية") mean "I'll reply soon myself"
  // — not a deferred-contact request. Bail out unless a real duration word is also present.
  if (SHORT_WAIT.test(t) && !REAL_DURATION.test(t)) {
    return { shouldSchedule: false, days: 0, declined: false }
  }

  // Explicit duration + deferring intent → schedule immediately
  // Guard: require deferring intent so trip-duration answers like "٧ أيام" don't trigger scheduling
  const days = parseDaysFromText(t)
  if (days !== null && DEFER_INTENT.test(t)) {
    return { shouldSchedule: true, days, declined: false }
  }

  // Previous agent message was a proposal → check if customer agreed.
  // Guard: the user message that triggered the proposal must have had DEFER_INTENT.
  // Without this, a misfired proposal (AI over-interpreting "ت" as "هفكر") would let
  // the next innocent "تمام" schedule a follow-up.
  const msgs = [...history]
  const lastBotIdx = msgs.reduce<number>((found, m, i) => m.role === 'assistant' ? i : found, -1)
  if (lastBotIdx >= 0 && isFollowUpProposal(msgs[lastBotIdx].content)) {
    const userBeforeBot = msgs.slice(0, lastBotIdx).reverse().find(m => m.role === 'user')
    if (userBeforeBot && DEFER_INTENT.test(userBeforeBot.content)) {
      // For short single-word agreement, match exact; for longer words, include substring
      if (AGREEMENT.some(w => t === w || (w.length > 3 && t.includes(w)))) {
        return { shouldSchedule: true, days: 1, declined: false }
      }
      // Customer counter-proposes a different duration ("لأ بعد يومين أحسن")
      if (days !== null) return { shouldSchedule: true, days, declined: false }
    }
  }

  return { shouldSchedule: false, days: 0, declined: false }
}

export function clampToWindow(date: Date): Date {
  const cairoHour = new Date(date.getTime() + CAIRO_OFFSET_MS).getUTCHours()
  if (cairoHour >= 9 && cairoHour < 22) return date
  const c = new Date(date.getTime() + CAIRO_OFFSET_MS)
  if (cairoHour >= 22) c.setUTCDate(c.getUTCDate() + 1)
  c.setUTCHours(9, 0, 0, 0)
  return new Date(c.getTime() - CAIRO_OFFSET_MS)
}
