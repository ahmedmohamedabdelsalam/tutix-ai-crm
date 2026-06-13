interface UmrahProgram {
  tripNumber: number
  programNumber: number
  duration: number
  nights: number
  departureDate: string
  returnDate: string
  month: string
  haramainTrain: boolean
  meccaNights: number
  medinaNights: number
  medinaHotel: string
  medinaBreakfast: boolean
  meccaHotel: string
  meccaBreakfast: boolean
  priceQuad: number
  priceTriple: number
  priceDouble: number
}

export const UMRAH_PROGRAMS_2026: UmrahProgram[] = [
  // ── Trip 1: 15 days, 8-22 July 2026, no train, 10 Mecca / 4 Medina ───────
  { tripNumber: 1, programNumber: 1, duration: 15, nights: 14, departureDate: '٨ يوليو ٢٠٢٦',  returnDate: '٢٢ يوليو ٢٠٢٦',   month: 'يوليو',   haramainTrain: false, meccaNights: 10, medinaNights: 4, medinaHotel: 'أوديست',          medinaBreakfast: false, meccaHotel: 'سنود الريان',     meccaBreakfast: false, priceQuad: 41000, priceTriple: 44500, priceDouble: 50500 },
  { tripNumber: 1, programNumber: 2, duration: 15, nights: 14, departureDate: '٨ يوليو ٢٠٢٦',  returnDate: '٢٢ يوليو ٢٠٢٦',   month: 'يوليو',   haramainTrain: false, meccaNights: 10, medinaNights: 4, medinaHotel: 'أوديست',          medinaBreakfast: false, meccaHotel: 'سنود الريان',     meccaBreakfast: false, priceQuad: 45000, priceTriple: 48500, priceDouble: 54500 },
  { tripNumber: 1, programNumber: 3, duration: 15, nights: 14, departureDate: '٨ يوليو ٢٠٢٦',  returnDate: '٢٢ يوليو ٢٠٢٦',   month: 'يوليو',   haramainTrain: false, meccaNights: 10, medinaNights: 4, medinaHotel: 'أوديست',          medinaBreakfast: false, meccaHotel: 'إعمار المنار',    meccaBreakfast: true,  priceQuad: 53500, priceTriple: 57900, priceDouble: 65500 },

  // ── Trip 2: 10 days, 15-24 July 2026, with train, 5 Mecca / 4 Medina ─────
  { tripNumber: 2, programNumber: 1, duration: 10, nights:  9, departureDate: '١٥ يوليو ٢٠٢٦', returnDate: '٢٤ يوليو ٢٠٢٦',   month: 'يوليو',   haramainTrain: true,  meccaNights:  5, medinaNights: 4, medinaHotel: 'جراند بلازا',      medinaBreakfast: false, meccaHotel: 'أزكى الصفا',      meccaBreakfast: true,  priceQuad: 52700, priceTriple: 55700, priceDouble: 62700 },
  { tripNumber: 2, programNumber: 2, duration: 10, nights:  9, departureDate: '١٥ يوليو ٢٠٢٦', returnDate: '٢٤ يوليو ٢٠٢٦',   month: 'يوليو',   haramainTrain: true,  meccaNights:  5, medinaNights: 4, medinaHotel: 'الحارثية',         medinaBreakfast: true,  meccaHotel: 'الصفوة',          meccaBreakfast: true,  priceQuad: 68000, priceTriple: 72500, priceDouble: 82000 },
  { tripNumber: 2, programNumber: 3, duration: 10, nights:  9, departureDate: '١٥ يوليو ٢٠٢٦', returnDate: '٢٤ يوليو ٢٠٢٦',   month: 'يوليو',   haramainTrain: true,  meccaNights:  5, medinaNights: 4, medinaHotel: 'الحارثية',         medinaBreakfast: true,  meccaHotel: 'موفنبيك',         meccaBreakfast: true,  priceQuad: 69000, priceTriple: 74000, priceDouble: 84000 },

  // ── Trip 3: 7 days, 20-26 July 2026, with train, 3 Mecca / 3 Medina ──────
  { tripNumber: 3, programNumber: 1, duration:  7, nights:  6, departureDate: '٢٠ يوليو ٢٠٢٦', returnDate: '٢٦ يوليو ٢٠٢٦',   month: 'يوليو',   haramainTrain: true,  meccaNights:  3, medinaNights: 3, medinaHotel: 'شذا ريجنسي',       medinaBreakfast: false, meccaHotel: 'الصفوة',          meccaBreakfast: true,  priceQuad: 53500, priceTriple: 57000, priceDouble: 62800 },
  { tripNumber: 3, programNumber: 2, duration:  7, nights:  6, departureDate: '٢٠ يوليو ٢٠٢٦', returnDate: '٢٦ يوليو ٢٠٢٦',   month: 'يوليو',   haramainTrain: true,  meccaNights:  3, medinaNights: 3, medinaHotel: 'شذا ريجنسي',       medinaBreakfast: false, meccaHotel: 'موفنبيك',         meccaBreakfast: true,  priceQuad: 55500, priceTriple: 58500, priceDouble: 65500 },
  { tripNumber: 3, programNumber: 3, duration:  7, nights:  6, departureDate: '٢٠ يوليو ٢٠٢٦', returnDate: '٢٦ يوليو ٢٠٢٦',   month: 'يوليو',   haramainTrain: true,  meccaNights:  3, medinaNights: 3, medinaHotel: 'أوديست',          medinaBreakfast: false, meccaHotel: 'رمادا الفائزين',  meccaBreakfast: false, priceQuad: 45500, priceTriple: 47500, priceDouble: 52000 },

  // ── Trip 4: 11 days, 21-31 July 2026, no train, 6 Mecca / 4 Medina ───────
  { tripNumber: 4, programNumber: 1, duration: 11, nights: 10, departureDate: '٢١ يوليو ٢٠٢٦', returnDate: '٣١ يوليو ٢٠٢٦',   month: 'يوليو',   haramainTrain: false, meccaNights:  6, medinaNights: 4, medinaHotel: 'أوديست',          medinaBreakfast: false, meccaHotel: 'رمادا الفائزين',  meccaBreakfast: false, priceQuad: 47500, priceTriple: 52500, priceDouble: 59000 },

  // ── Trip 5: 10 days, 26 Jul - 4 Aug 2026, with train, 5 Mecca / 4 Medina ─
  { tripNumber: 5, programNumber: 1, duration: 10, nights:  9, departureDate: '٢٦ يوليو ٢٠٢٦', returnDate: '٤ أغسطس ٢٠٢٦',   month: 'أغسطس',  haramainTrain: true,  meccaNights:  5, medinaNights: 4, medinaHotel: 'جراند بلازا',      medinaBreakfast: false, meccaHotel: 'أزكى الصفا',      meccaBreakfast: true,  priceQuad: 53000, priceTriple: 56200, priceDouble: 63200 },
  { tripNumber: 5, programNumber: 2, duration: 10, nights:  9, departureDate: '٢٦ يوليو ٢٠٢٦', returnDate: '٤ أغسطس ٢٠٢٦',   month: 'أغسطس',  haramainTrain: true,  meccaNights:  5, medinaNights: 4, medinaHotel: 'الحارثية',         medinaBreakfast: true,  meccaHotel: 'الصفوة',          meccaBreakfast: true,  priceQuad: 69000, priceTriple: 73500, priceDouble: 83000 },
  { tripNumber: 5, programNumber: 3, duration: 10, nights:  9, departureDate: '٢٦ يوليو ٢٠٢٦', returnDate: '٤ أغسطس ٢٠٢٦',   month: 'أغسطس',  haramainTrain: true,  meccaNights:  5, medinaNights: 4, medinaHotel: 'الحارثية',         medinaBreakfast: true,  meccaHotel: 'موفنبيك',         meccaBreakfast: true,  priceQuad: 70500, priceTriple: 76500, priceDouble: 86000 },

  // ── Trip 6: 11 days, 5-15 Aug 2026, no train, 6 Mecca / 4 Medina ─────────
  { tripNumber: 6, programNumber: 1, duration: 11, nights: 10, departureDate: '٥ أغسطس ٢٠٢٦',  returnDate: '١٥ أغسطس ٢٠٢٦',  month: 'أغسطس',  haramainTrain: false, meccaNights:  6, medinaNights: 4, medinaHotel: 'أوديست',          medinaBreakfast: false, meccaHotel: 'إعمار المنار',    meccaBreakfast: false, priceQuad: 48700, priceTriple: 52700, priceDouble: 59000 },

  // ── Trip 7: 7 days, 10-16 Aug 2026, with train, 3 Mecca / 3 Medina ───────
  { tripNumber: 7, programNumber: 1, duration:  7, nights:  6, departureDate: '١٠ أغسطس ٢٠٢٦', returnDate: '١٦ أغسطس ٢٠٢٦',  month: 'أغسطس',  haramainTrain: true,  meccaNights:  3, medinaNights: 3, medinaHotel: 'شذا ريجنسي',       medinaBreakfast: false, meccaHotel: 'الصفوة',          meccaBreakfast: true,  priceQuad: 56000, priceTriple: 60500, priceDouble: 67500 },
  { tripNumber: 7, programNumber: 2, duration:  7, nights:  6, departureDate: '١٠ أغسطس ٢٠٢٦', returnDate: '١٦ أغسطس ٢٠٢٦',  month: 'أغسطس',  haramainTrain: true,  meccaNights:  3, medinaNights: 3, medinaHotel: 'شذا ريجنسي',       medinaBreakfast: false, meccaHotel: 'موفنبيك',         meccaBreakfast: true,  priceQuad: 57000, priceTriple: 61500, priceDouble: 68500 },
  { tripNumber: 7, programNumber: 3, duration:  7, nights:  6, departureDate: '١٠ أغسطس ٢٠٢٦', returnDate: '١٦ أغسطس ٢٠٢٦',  month: 'أغسطس',  haramainTrain: true,  meccaNights:  3, medinaNights: 3, medinaHotel: 'أوديست',          medinaBreakfast: false, meccaHotel: 'أزكى الصفا',      meccaBreakfast: true,  priceQuad: 48000, priceTriple: 50500, priceDouble: 55000 },

  // ── Trip 8: 11 days, 12-22 Aug 2026, no train, 6 Mecca / 4 Medina ───────
  { tripNumber: 8, programNumber: 1, duration: 11, nights: 10, departureDate: '١٢ أغسطس ٢٠٢٦', returnDate: '٢٢ أغسطس ٢٠٢٦',  month: 'أغسطس',  haramainTrain: false, meccaNights:  6, medinaNights: 4, medinaHotel: 'أوديست',          medinaBreakfast: false, meccaHotel: 'رمادا الفائزين',  meccaBreakfast: false, priceQuad: 47500, priceTriple: 51800, priceDouble: 59900 },

  // ── Trip 9: 10 days, 18-27 Aug 2026, with train, 4 Mecca / 5 Medina ──────
  { tripNumber: 9, programNumber: 1, duration: 10, nights:  9, departureDate: '١٨ أغسطس ٢٠٢٦', returnDate: '٢٧ أغسطس ٢٠٢٦',  month: 'أغسطس',  haramainTrain: true,  meccaNights:  4, medinaNights: 5, medinaHotel: 'جراند بلازا',      medinaBreakfast: false, meccaHotel: 'أزكى الصفا',      meccaBreakfast: true,  priceQuad: 54500, priceTriple: 56500, priceDouble: 62700 },
  { tripNumber: 9, programNumber: 2, duration: 10, nights:  9, departureDate: '١٨ أغسطس ٢٠٢٦', returnDate: '٢٧ أغسطس ٢٠٢٦',  month: 'أغسطس',  haramainTrain: true,  meccaNights:  4, medinaNights: 5, medinaHotel: 'الحارثية',         medinaBreakfast: true,  meccaHotel: 'الصفوة',          meccaBreakfast: true,  priceQuad: 69500, priceTriple: 75500, priceDouble: 85000 },
  { tripNumber: 9, programNumber: 3, duration: 10, nights:  9, departureDate: '١٨ أغسطس ٢٠٢٦', returnDate: '٢٧ أغسطس ٢٠٢٦',  month: 'أغسطس',  haramainTrain: true,  meccaNights:  4, medinaNights: 5, medinaHotel: 'الحارثية',         medinaBreakfast: true,  meccaHotel: 'موفنبيك',         meccaBreakfast: true,  priceQuad: 72500, priceTriple: 78000, priceDouble: 91000 },

  // ── Trip 10: 15 days, 26 Aug - 9 Sep 2026, no train, 10 Mecca / 4 Medina ─
  { tripNumber: 10, programNumber: 1, duration: 15, nights: 14, departureDate: '٢٦ أغسطس ٢٠٢٦', returnDate: '٩ سبتمبر ٢٠٢٦',   month: 'سبتمبر',  haramainTrain: false, meccaNights: 10, medinaNights: 4, medinaHotel: 'أوديست',          medinaBreakfast: false, meccaHotel: 'سنود الريان',     meccaBreakfast: false, priceQuad: 46000, priceTriple: 49100, priceDouble: 55100 },
  { tripNumber: 10, programNumber: 2, duration: 15, nights: 14, departureDate: '٢٦ أغسطس ٢٠٢٦', returnDate: '٩ سبتمبر ٢٠٢٦',   month: 'سبتمبر',  haramainTrain: false, meccaNights: 10, medinaNights: 4, medinaHotel: 'أوديست',          medinaBreakfast: false, meccaHotel: 'رمادا',           meccaBreakfast: false, priceQuad: 53500, priceTriple: 58000, priceDouble: 68500 },

  // ── Trip 11: 10 days, 1-11 Sep 2026, no train, 5 Mecca / 4 Medina ────────
  { tripNumber: 11, programNumber: 1, duration: 10, nights:  9, departureDate: '١ سبتمبر ٢٠٢٦',  returnDate: '١١ سبتمبر ٢٠٢٦',  month: 'سبتمبر',  haramainTrain: false, meccaNights:  5, medinaNights: 4, medinaHotel: 'جراند بلازا',      medinaBreakfast: false, meccaHotel: 'أزكى الصفا',      meccaBreakfast: true,  priceQuad: 54500, priceTriple: 57000, priceDouble: 63000 },
  { tripNumber: 11, programNumber: 2, duration: 10, nights:  9, departureDate: '١ سبتمبر ٢٠٢٦',  returnDate: '١١ سبتمبر ٢٠٢٦',  month: 'سبتمبر',  haramainTrain: false, meccaNights:  5, medinaNights: 4, medinaHotel: 'الحارثية',         medinaBreakfast: false, meccaHotel: 'الصفوة',          meccaBreakfast: false, priceQuad: 69900, priceTriple: 74900, priceDouble: 85900 },
  { tripNumber: 11, programNumber: 3, duration: 10, nights:  9, departureDate: '١ سبتمبر ٢٠٢٦',  returnDate: '١١ سبتمبر ٢٠٢٦',  month: 'سبتمبر',  haramainTrain: false, meccaNights:  5, medinaNights: 4, medinaHotel: 'الحارثية',         medinaBreakfast: false, meccaHotel: 'موفنبيك',         meccaBreakfast: false, priceQuad: 72500, priceTriple: 78500, priceDouble: 91000 },
  { tripNumber: 11, programNumber: 4, duration: 10, nights:  9, departureDate: '١ سبتمبر ٢٠٢٦',  returnDate: '١١ سبتمبر ٢٠٢٦',  month: 'سبتمبر',  haramainTrain: false, meccaNights:  5, medinaNights: 4, medinaHotel: 'أوديست',          medinaBreakfast: false, meccaHotel: 'رمادا الفائزين',  meccaBreakfast: false, priceQuad: 47000, priceTriple: 50500, priceDouble: 56500 },
  { tripNumber: 11, programNumber: 5, duration: 10, nights:  9, departureDate: '١ سبتمبر ٢٠٢٦',  returnDate: '١١ سبتمبر ٢٠٢٦',  month: 'سبتمبر',  haramainTrain: false, meccaNights:  5, medinaNights: 4, medinaHotel: 'أوديست',          medinaBreakfast: false, meccaHotel: 'سنود الريان',     meccaBreakfast: false, priceQuad: 44000, priceTriple: 47000, priceDouble: 51500 },

  // ── Trip 12: 7 days, 7-13 Sep 2026, with train, 3 Mecca / 3 Medina ───────
  { tripNumber: 12, programNumber: 1, duration:  7, nights:  6, departureDate: '٧ سبتمبر ٢٠٢٦',  returnDate: '١٣ سبتمبر ٢٠٢٦',  month: 'سبتمبر',  haramainTrain: true,  meccaNights:  3, medinaNights: 3, medinaHotel: 'شذا ريجنسي',       medinaBreakfast: false, meccaHotel: 'الصفوة',          meccaBreakfast: true,  priceQuad: 56000, priceTriple: 59500, priceDouble: 66500 },
  { tripNumber: 12, programNumber: 2, duration:  7, nights:  6, departureDate: '٧ سبتمبر ٢٠٢٦',  returnDate: '١٣ سبتمبر ٢٠٢٦',  month: 'سبتمبر',  haramainTrain: true,  meccaNights:  3, medinaNights: 3, medinaHotel: 'أوديست',          medinaBreakfast: false, meccaHotel: 'أزكى الصفا',      meccaBreakfast: true,  priceQuad: 48500, priceTriple: 51000, priceDouble: 56000 },
  { tripNumber: 12, programNumber: 3, duration:  7, nights:  6, departureDate: '٧ سبتمبر ٢٠٢٦',  returnDate: '١٣ سبتمبر ٢٠٢٦',  month: 'سبتمبر',  haramainTrain: true,  meccaNights:  3, medinaNights: 3, medinaHotel: 'شذا ريجنسي',       medinaBreakfast: false, meccaHotel: 'موفنبيك',         meccaBreakfast: true,  priceQuad: 57000, priceTriple: 60500, priceDouble: 67500 },
]

// ── helpers ─────────────────────────────────────────────────────────────────

function toAI(n: number): string {
  return String(n).split('').map(c => {
    const i = '0123456789'.indexOf(c)
    return i >= 0 ? '٠١٢٣٤٥٦٧٨٩'[i] : c
  }).join('')
}

function fmtPrice(n: number): string {
  return String(n)
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    .split('')
    .map(c => {
      const i = '0123456789'.indexOf(c)
      return i >= 0 ? '٠١٢٣٤٥٦٧٨٩'[i] : '٬'
    })
    .join('')
}

function fmtDuration(d: number): string {
  return toAI(d) + (d <= 10 ? ' أيام' : ' يوم')
}

// ── main export ──────────────────────────────────────────────────────────────

export function buildUmrahCatalogTable(): string {
  const MONTHS = ['يوليو', 'أغسطس', 'سبتمبر']

  // Availability summary
  const availLines = MONTHS.map(m => {
    const durations = [...new Set(
      UMRAH_PROGRAMS_2026.filter(p => p.month === m).map(p => p.duration),
    )].sort((a, b) => a - b)
    return `${m} ٢٠٢٦: ${durations.map(fmtDuration).join(' و ')}`
  })

  const header = `## القسم ٣أ — برامج العمرة ٢٠٢٦ (الأسعار بالجنيه للفرد — اقرأ هذا القسم كاملاً قبل الرد)

ملخص التوافر السريع:
${availLines.join('\n')}

قاعدة السعر: ٤ أفراد فأكثر → رباعي | ٣ أفراد → ثلاثي | ٢ أفراد → ثنائي | ١ فرد → قدّر بالثنائي
الإجمالي = سعر الفرد × عدد الأفراد — اعرض إجمالياً واحداً بس لكل برنامج`

  const tableHeader =
    '| المدة | التواريخ | فندق مكة | فندق المدينة | إفطار مكة | إفطار المدينة | قطار الحرمين | رباعي | ثلاثي | ثنائي |'
  const tableSep =
    '|-------|----------|---------|-------------|-----------|----------------|--------------|-------|-------|-------|'

  const sections: string[] = [header]

  for (const month of MONTHS) {
    const progs = UMRAH_PROGRAMS_2026
      .filter(p => p.month === month)
      .sort((a, b) => a.duration - b.duration || a.tripNumber - b.tripNumber || a.programNumber - b.programNumber)

    if (progs.length === 0) continue

    sections.push(`\n### برامج ${month} ٢٠٢٦\n`)
    sections.push(tableHeader)
    sections.push(tableSep)

    for (const p of progs) {
      const row = [
        fmtDuration(p.duration),
        `${p.departureDate.split(' ')[0]}-${p.returnDate.split(' ')[0]} ${p.returnDate.split(' ')[1]}`,
        p.meccaHotel,
        p.medinaHotel,
        p.meccaBreakfast  ? 'نعم' : 'لا',
        p.medinaBreakfast ? 'نعم' : 'لا',
        p.haramainTrain   ? 'نعم' : 'لا',
        fmtPrice(p.priceQuad),
        fmtPrice(p.priceTriple),
        fmtPrice(p.priceDouble),
      ]
      sections.push('| ' + row.join(' | ') + ' |')
    }
  }

  return sections.join('\n')
}
