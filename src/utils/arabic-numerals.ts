export const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩'

export const CAIRO_OFFSET_MS = 2 * 60 * 60 * 1000

export function toArabicIndic(n: number): string {
  return String(n).split('').map(c => {
    const i = '0123456789'.indexOf(c)
    return i >= 0 ? ARABIC_INDIC[i] : c
  }).join('')
}

/**
 * Arabic counted-noun agreement (تمييز العدد).
 *   1   → singular, numeral omitted  ("يوم")
 *   2   → dual, numeral omitted      ("يومين")
 *   3–10 → numeral + plural          ("٧ أيام")
 *   11+ → numeral + singular         ("١٥ يوم")
 * 0 and negatives fall through to the 11+ shape ("٠ يوم"), which is the
 * correct reading for zero in Arabic.
 */
export function arabicCount(
  n: number,
  forms: { one: string; two: string; few: string; many: string },
): string {
  if (n === 1) return forms.one
  if (n === 2) return forms.two
  if (n >= 3 && n <= 10) return `${toArabicIndic(n)} ${forms.few}`
  return `${toArabicIndic(n)} ${forms.many}`
}

export const DAYS   = { one: 'يوم',  two: 'يومين',  few: 'أيام',  many: 'يوم'  }
export const NIGHTS = { one: 'ليلة', two: 'ليلتين', few: 'ليالي', many: 'ليلة' }
export const TIMES  = { one: 'مرة',  two: 'مرتين',  few: 'مرات',  many: 'مرة'  }

export function formatPrice(n: number): string {
  return String(n)
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    .split('')
    .map(c => {
      const i = '0123456789'.indexOf(c)
      return i >= 0 ? ARABIC_INDIC[i] : '٬'
    })
    .join('')
}
