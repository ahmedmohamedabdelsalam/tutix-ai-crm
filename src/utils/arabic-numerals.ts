export const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩'

export const CAIRO_OFFSET_MS = 2 * 60 * 60 * 1000

export function toArabicIndic(n: number): string {
  return String(n).split('').map(c => {
    const i = '0123456789'.indexOf(c)
    return i >= 0 ? ARABIC_INDIC[i] : c
  }).join('')
}

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
