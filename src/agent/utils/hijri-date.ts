// eslint-disable-next-line @typescript-eslint/no-require-imports
const mh = require('moment-hijri') as (date: Date | string, fmt?: string) => any

const HIJRI_MONTHS_AR = [
  'محرم', 'صفر', 'ربيع الأول', 'ربيع الثاني',
  'جمادى الأولى', 'جمادى الثانية', 'رجب', 'شعبان',
  'رمضان', 'شوال', 'ذو القعدة', 'ذو الحجة',
]

const ARABIC_TO_GREGORIAN_MONTH: Record<string, number> = {
  'يناير': 1, 'فبراير': 2, 'مارس': 3, 'أبريل': 4,
  'مايو': 5, 'يونيو': 6, 'يوليو': 7, 'أغسطس': 8,
  'سبتمبر': 9, 'أكتوبر': 10, 'نوفمبر': 11, 'ديسمبر': 12,
}

export const HIJRI_MONTH_TO_NUM: Record<string, number> = {
  'محرم': 1, 'صفر': 2, 'ربيع الأول': 3, 'ربيع الثاني': 4,
  'جمادى الأولى': 5, 'جمادى الثانية': 6, 'رجب': 7, 'شعبان': 8,
  'رمضان': 9, 'شوال': 10, 'ذو القعدة': 11, 'ذو الحجة': 12,
}

export const ARABIC_MONTH_NAMES_AR = [
  'يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
  'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر',
]

function toAI(n: number): string {
  return String(n).replace(/\d/g, d => '٠١٢٣٤٥٦٧٨٩'[+d])
}

export interface HijriResult {
  day: number
  month: string
  year: number
  formatted: string
}

export function gregorianToHijri(date: Date): HijriResult {
  const m = mh(date)
  const day: number = m.iDate()
  const month: string = HIJRI_MONTHS_AR[m.iMonth() as number]
  const year: number = m.iYear()
  return { day, month, year, formatted: `${toAI(day)} ${month} ${toAI(year)}هـ` }
}

/**
 * Returns the Hijri month(s) that overlap a given Arabic-named Gregorian month.
 * e.g. gregorianMonthToHijriRange('يوليو', 2026) → 'محرم / صفر ١٤٤٨هـ'
 */
export function gregorianMonthToHijriRange(arabicMonth: string, year: number): string {
  const monthNum = ARABIC_TO_GREGORIAN_MONTH[arabicMonth]
  if (!monthNum) return ''
  const h1 = gregorianToHijri(new Date(year, monthNum - 1, 1))
  const h2 = gregorianToHijri(new Date(year, monthNum, 0))
  if (h1.month === h2.month && h1.year === h2.year) {
    return `${h1.month} ${toAI(h1.year)}هـ`
  }
  const yearSuffix = h1.year === h2.year ? ` ${toAI(h1.year)}هـ` : ` ${toAI(h1.year)}هـ / ${toAI(h2.year)}هـ`
  return `${h1.month} / ${h2.month}${yearSuffix}`
}

/**
 * Returns which Gregorian months in approxGregorianYear contain a given Hijri month name.
 * Used to answer "عندكم رحلات في رجب؟" — finds the matching Gregorian month(s) in the catalog year.
 */
export function hijriMonthToGregorianMonths(hijriMonth: string, approxGregorianYear: number): string[] {
  const results: string[] = []
  for (let gMonth = 1; gMonth <= 12; gMonth++) {
    const h = gregorianToHijri(new Date(approxGregorianYear, gMonth - 1, 15))
    if (h.month === hijriMonth) {
      results.push(ARABIC_MONTH_NAMES_AR[gMonth - 1])
    }
    // Also check adjacent year in case it straddles
    const hNext = gregorianToHijri(new Date(approxGregorianYear + 1, gMonth - 1, 15))
    if (hNext.month === hijriMonth && !results.includes(ARABIC_MONTH_NAMES_AR[gMonth - 1])) {
      results.push(ARABIC_MONTH_NAMES_AR[gMonth - 1])
    }
  }
  return [...new Set(results)]
}
