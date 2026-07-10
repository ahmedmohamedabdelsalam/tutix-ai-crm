import { toArabicIndic, formatPrice } from '../../utils/arabic-numerals'

export type ProgramType = 'اقتصادي' | 'اقتصادي متميز' | 'خمس نجوم'

export interface UmrahProgram {
  tripNumber: number
  programNumber: number
  duration: number
  nights: number
  departureDate: string
  returnDate: string
  departureDateISO: string    // YYYY-MM-DD — used for Hijri conversion
  returnDateISO: string       // YYYY-MM-DD
  departureDateHijri: string  // pre-computed via moment-hijri, e.g. '٢٣ محرم ١٤٤٨هـ'
  returnDateHijri: string
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
  programType: ProgramType
}

export const HOTEL_BOOKING_LINKS: Record<string, string> = {
  'أوديست':          'https://www.booking.com/Share-cGbCMAy',
  'سنود الريان':     'https://sa.trip.com/hotels/makkah-hotel-detail-81468178/snood-al-rayyan-hotel/',
  'إعمار المنار':    'https://www.booking.com/Share-jCPBIDW',
  'أزكى الصفا':      'https://www.booking.com/hotel/sa/azka-al-safa.ar.html',
  'الصفوة':          'https://www.booking.com/Share-8hDcymv',
  'الحارثية':        'https://www.booking.com/Share-gFleQHr',
  'جراند بلازا':     'https://www.booking.com/Share-t752OEg',
  'موفنبيك':         'https://www.booking.com/Share-zYAacjf',
  'شذا ريجنسي':      'https://www.booking.com/Share-3JCkDA',
  'رمادا الفائزين':  'https://www.trivago.com/share/ShwM6UtJbZ',
}

export const UMRAH_PROGRAMS_2026: UmrahProgram[] = [
  // ── Trip 1: 15 days, 8-22 July 2026 — ٢٣ محرم ١٤٤٨هـ → ٨ صفر ١٤٤٨هـ ──────
  { tripNumber: 1, programNumber: 1, duration: 15, nights: 14, departureDate: '٨ يوليو ٢٠٢٦',  returnDate: '٢٢ يوليو ٢٠٢٦',  departureDateISO: '2026-07-08', returnDateISO: '2026-07-22', departureDateHijri: '٢٣ محرم ١٤٤٨هـ',    returnDateHijri: '٨ صفر ١٤٤٨هـ',         month: 'يوليو',  haramainTrain: false, meccaNights: 10, medinaNights: 4, medinaHotel: 'أوديست',       medinaBreakfast: false, meccaHotel: 'سنود الريان',    meccaBreakfast: false, priceQuad: 41000, priceTriple: 44500, priceDouble: 50500, programType: 'اقتصادي' },
  { tripNumber: 1, programNumber: 2, duration: 15, nights: 14, departureDate: '٨ يوليو ٢٠٢٦',  returnDate: '٢٢ يوليو ٢٠٢٦',  departureDateISO: '2026-07-08', returnDateISO: '2026-07-22', departureDateHijri: '٢٣ محرم ١٤٤٨هـ',    returnDateHijri: '٨ صفر ١٤٤٨هـ',         month: 'يوليو',  haramainTrain: false, meccaNights: 10, medinaNights: 4, medinaHotel: 'أوديست',       medinaBreakfast: false, meccaHotel: 'سنود الريان',    meccaBreakfast: false, priceQuad: 45000, priceTriple: 48500, priceDouble: 54500, programType: 'اقتصادي' },
  { tripNumber: 1, programNumber: 3, duration: 15, nights: 14, departureDate: '٨ يوليو ٢٠٢٦',  returnDate: '٢٢ يوليو ٢٠٢٦',  departureDateISO: '2026-07-08', returnDateISO: '2026-07-22', departureDateHijri: '٢٣ محرم ١٤٤٨هـ',    returnDateHijri: '٨ صفر ١٤٤٨هـ',         month: 'يوليو',  haramainTrain: false, meccaNights: 10, medinaNights: 4, medinaHotel: 'أوديست',       medinaBreakfast: false, meccaHotel: 'إعمار المنار',   meccaBreakfast: true,  priceQuad: 53500, priceTriple: 57900, priceDouble: 65500, programType: 'اقتصادي متميز' },

  // ── Trip 2: 10 days, 15-24 July 2026 — ١ صفر ١٤٤٨هـ → ١٠ صفر ١٤٤٨هـ ─────
  { tripNumber: 2, programNumber: 1, duration: 10, nights:  9, departureDate: '١٥ يوليو ٢٠٢٦', returnDate: '٢٤ يوليو ٢٠٢٦',  departureDateISO: '2026-07-15', returnDateISO: '2026-07-24', departureDateHijri: '١ صفر ١٤٤٨هـ',      returnDateHijri: '١٠ صفر ١٤٤٨هـ',        month: 'يوليو',  haramainTrain: true,  meccaNights:  5, medinaNights: 4, medinaHotel: 'جراند بلازا',   medinaBreakfast: false, meccaHotel: 'أزكى الصفا',     meccaBreakfast: true,  priceQuad: 52700, priceTriple: 55700, priceDouble: 62700, programType: 'اقتصادي متميز' },
  { tripNumber: 2, programNumber: 2, duration: 10, nights:  9, departureDate: '١٥ يوليو ٢٠٢٦', returnDate: '٢٤ يوليو ٢٠٢٦',  departureDateISO: '2026-07-15', returnDateISO: '2026-07-24', departureDateHijri: '١ صفر ١٤٤٨هـ',      returnDateHijri: '١٠ صفر ١٤٤٨هـ',        month: 'يوليو',  haramainTrain: true,  meccaNights:  5, medinaNights: 4, medinaHotel: 'الحارثية',      medinaBreakfast: true,  meccaHotel: 'الصفوة',         meccaBreakfast: true,  priceQuad: 68000, priceTriple: 72500, priceDouble: 82000, programType: 'خمس نجوم' },
  { tripNumber: 2, programNumber: 3, duration: 10, nights:  9, departureDate: '١٥ يوليو ٢٠٢٦', returnDate: '٢٤ يوليو ٢٠٢٦',  departureDateISO: '2026-07-15', returnDateISO: '2026-07-24', departureDateHijri: '١ صفر ١٤٤٨هـ',      returnDateHijri: '١٠ صفر ١٤٤٨هـ',        month: 'يوليو',  haramainTrain: true,  meccaNights:  5, medinaNights: 4, medinaHotel: 'الحارثية',      medinaBreakfast: true,  meccaHotel: 'موفنبيك',        meccaBreakfast: true,  priceQuad: 69000, priceTriple: 74000, priceDouble: 84000, programType: 'خمس نجوم' },

  // ── Trip 3: 7 days, 20-26 July 2026 — ٦ صفر ١٤٤٨هـ → ١٢ صفر ١٤٤٨هـ ──────
  { tripNumber: 3, programNumber: 1, duration:  7, nights:  6, departureDate: '٢٠ يوليو ٢٠٢٦', returnDate: '٢٦ يوليو ٢٠٢٦',  departureDateISO: '2026-07-20', returnDateISO: '2026-07-26', departureDateHijri: '٦ صفر ١٤٤٨هـ',      returnDateHijri: '١٢ صفر ١٤٤٨هـ',        month: 'يوليو',  haramainTrain: true,  meccaNights:  3, medinaNights: 3, medinaHotel: 'شذا ريجنسي',    medinaBreakfast: false, meccaHotel: 'الصفوة',         meccaBreakfast: true,  priceQuad: 53500, priceTriple: 57000, priceDouble: 62800, programType: 'خمس نجوم' },
  { tripNumber: 3, programNumber: 2, duration:  7, nights:  6, departureDate: '٢٠ يوليو ٢٠٢٦', returnDate: '٢٦ يوليو ٢٠٢٦',  departureDateISO: '2026-07-20', returnDateISO: '2026-07-26', departureDateHijri: '٦ صفر ١٤٤٨هـ',      returnDateHijri: '١٢ صفر ١٤٤٨هـ',        month: 'يوليو',  haramainTrain: true,  meccaNights:  3, medinaNights: 3, medinaHotel: 'شذا ريجنسي',    medinaBreakfast: false, meccaHotel: 'موفنبيك',        meccaBreakfast: true,  priceQuad: 55500, priceTriple: 58500, priceDouble: 65500, programType: 'خمس نجوم' },
  { tripNumber: 3, programNumber: 3, duration:  7, nights:  6, departureDate: '٢٠ يوليو ٢٠٢٦', returnDate: '٢٦ يوليو ٢٠٢٦',  departureDateISO: '2026-07-20', returnDateISO: '2026-07-26', departureDateHijri: '٦ صفر ١٤٤٨هـ',      returnDateHijri: '١٢ صفر ١٤٤٨هـ',        month: 'يوليو',  haramainTrain: true,  meccaNights:  3, medinaNights: 3, medinaHotel: 'أوديست',       medinaBreakfast: false, meccaHotel: 'رمادا الفائزين', meccaBreakfast: false, priceQuad: 45500, priceTriple: 47500, priceDouble: 52000, programType: 'اقتصادي متميز' },

  // ── Trip 4: 11 days, 21-31 July 2026 — ٧ صفر ١٤٤٨هـ → ١٧ صفر ١٤٤٨هـ ─────
  { tripNumber: 4, programNumber: 1, duration: 11, nights: 10, departureDate: '٢١ يوليو ٢٠٢٦', returnDate: '٣١ يوليو ٢٠٢٦',  departureDateISO: '2026-07-21', returnDateISO: '2026-07-31', departureDateHijri: '٧ صفر ١٤٤٨هـ',      returnDateHijri: '١٧ صفر ١٤٤٨هـ',        month: 'يوليو',  haramainTrain: false, meccaNights:  6, medinaNights: 4, medinaHotel: 'أوديست',       medinaBreakfast: false, meccaHotel: 'رمادا الفائزين', meccaBreakfast: false, priceQuad: 47500, priceTriple: 52500, priceDouble: 59000, programType: 'اقتصادي متميز' },

  // ── Trip 5: 10 days, 26 Jul-4 Aug 2026 — ١٢ صفر ١٤٤٨هـ → ٢١ صفر ١٤٤٨هـ ──
  { tripNumber: 5, programNumber: 1, duration: 10, nights:  9, departureDate: '٢٦ يوليو ٢٠٢٦', returnDate: '٤ أغسطس ٢٠٢٦',  departureDateISO: '2026-07-26', returnDateISO: '2026-08-04', departureDateHijri: '١٢ صفر ١٤٤٨هـ',     returnDateHijri: '٢١ صفر ١٤٤٨هـ',        month: 'يوليو', haramainTrain: true,  meccaNights:  5, medinaNights: 4, medinaHotel: 'جراند بلازا',   medinaBreakfast: false, meccaHotel: 'أزكى الصفا',     meccaBreakfast: true,  priceQuad: 53000, priceTriple: 56200, priceDouble: 63200, programType: 'اقتصادي متميز' },
  { tripNumber: 5, programNumber: 2, duration: 10, nights:  9, departureDate: '٢٦ يوليو ٢٠٢٦', returnDate: '٤ أغسطس ٢٠٢٦',  departureDateISO: '2026-07-26', returnDateISO: '2026-08-04', departureDateHijri: '١٢ صفر ١٤٤٨هـ',     returnDateHijri: '٢١ صفر ١٤٤٨هـ',        month: 'يوليو', haramainTrain: true,  meccaNights:  5, medinaNights: 4, medinaHotel: 'الحارثية',      medinaBreakfast: true,  meccaHotel: 'الصفوة',         meccaBreakfast: true,  priceQuad: 69000, priceTriple: 73500, priceDouble: 83000, programType: 'خمس نجوم' },
  { tripNumber: 5, programNumber: 3, duration: 10, nights:  9, departureDate: '٢٦ يوليو ٢٠٢٦', returnDate: '٤ أغسطس ٢٠٢٦',  departureDateISO: '2026-07-26', returnDateISO: '2026-08-04', departureDateHijri: '١٢ صفر ١٤٤٨هـ',     returnDateHijri: '٢١ صفر ١٤٤٨هـ',        month: 'يوليو', haramainTrain: true,  meccaNights:  5, medinaNights: 4, medinaHotel: 'الحارثية',      medinaBreakfast: true,  meccaHotel: 'موفنبيك',        meccaBreakfast: true,  priceQuad: 70500, priceTriple: 76500, priceDouble: 86000, programType: 'خمس نجوم' },

  // ── Trip 6: 11 days, 5-15 Aug 2026 — ٢٢ صفر ١٤٤٨هـ → ٢ ربيع الأول ١٤٤٨هـ ─
  { tripNumber: 6, programNumber: 1, duration: 11, nights: 10, departureDate: '٥ أغسطس ٢٠٢٦',  returnDate: '١٥ أغسطس ٢٠٢٦', departureDateISO: '2026-08-05', returnDateISO: '2026-08-15', departureDateHijri: '٢٢ صفر ١٤٤٨هـ',     returnDateHijri: '٢ ربيع الأول ١٤٤٨هـ',  month: 'أغسطس', haramainTrain: false, meccaNights:  6, medinaNights: 4, medinaHotel: 'أوديست',       medinaBreakfast: false, meccaHotel: 'إعمار المنار',   meccaBreakfast: false, priceQuad: 48700, priceTriple: 52700, priceDouble: 59000, programType: 'اقتصادي متميز' },

  // ── Trip 7: 7 days, 10-16 Aug 2026 — ٢٧ صفر ١٤٤٨هـ → ٣ ربيع الأول ١٤٤٨هـ ─
  { tripNumber: 7, programNumber: 1, duration:  7, nights:  6, departureDate: '١٠ أغسطس ٢٠٢٦', returnDate: '١٦ أغسطس ٢٠٢٦', departureDateISO: '2026-08-10', returnDateISO: '2026-08-16', departureDateHijri: '٢٧ صفر ١٤٤٨هـ',     returnDateHijri: '٣ ربيع الأول ١٤٤٨هـ',  month: 'أغسطس', haramainTrain: true,  meccaNights:  3, medinaNights: 3, medinaHotel: 'شذا ريجنسي',    medinaBreakfast: false, meccaHotel: 'الصفوة',         meccaBreakfast: true,  priceQuad: 56000, priceTriple: 60500, priceDouble: 67500, programType: 'خمس نجوم' },
  { tripNumber: 7, programNumber: 2, duration:  7, nights:  6, departureDate: '١٠ أغسطس ٢٠٢٦', returnDate: '١٦ أغسطس ٢٠٢٦', departureDateISO: '2026-08-10', returnDateISO: '2026-08-16', departureDateHijri: '٢٧ صفر ١٤٤٨هـ',     returnDateHijri: '٣ ربيع الأول ١٤٤٨هـ',  month: 'أغسطس', haramainTrain: true,  meccaNights:  3, medinaNights: 3, medinaHotel: 'شذا ريجنسي',    medinaBreakfast: false, meccaHotel: 'موفنبيك',        meccaBreakfast: true,  priceQuad: 57000, priceTriple: 61500, priceDouble: 68500, programType: 'خمس نجوم' },
  { tripNumber: 7, programNumber: 3, duration:  7, nights:  6, departureDate: '١٠ أغسطس ٢٠٢٦', returnDate: '١٦ أغسطس ٢٠٢٦', departureDateISO: '2026-08-10', returnDateISO: '2026-08-16', departureDateHijri: '٢٧ صفر ١٤٤٨هـ',     returnDateHijri: '٣ ربيع الأول ١٤٤٨هـ',  month: 'أغسطس', haramainTrain: true,  meccaNights:  3, medinaNights: 3, medinaHotel: 'أوديست',       medinaBreakfast: false, meccaHotel: 'أزكى الصفا',     meccaBreakfast: true,  priceQuad: 48000, priceTriple: 50500, priceDouble: 55000, programType: 'اقتصادي متميز' },

  // ── Trip 8: 11 days, 12-22 Aug 2026 — ٢٩ صفر ١٤٤٨هـ → ٩ ربيع الأول ١٤٤٨هـ
  { tripNumber: 8, programNumber: 1, duration: 11, nights: 10, departureDate: '١٢ أغسطس ٢٠٢٦', returnDate: '٢٢ أغسطس ٢٠٢٦', departureDateISO: '2026-08-12', returnDateISO: '2026-08-22', departureDateHijri: '٢٩ صفر ١٤٤٨هـ',     returnDateHijri: '٩ ربيع الأول ١٤٤٨هـ',  month: 'أغسطس', haramainTrain: false, meccaNights:  6, medinaNights: 4, medinaHotel: 'أوديست',       medinaBreakfast: false, meccaHotel: 'رمادا الفائزين', meccaBreakfast: false, priceQuad: 47500, priceTriple: 51800, priceDouble: 59900, programType: 'اقتصادي متميز' },

  // ── Trip 9: 10 days, 18-27 Aug 2026 — ٥ ربيع الأول ١٤٤٨هـ → ١٤ ربيع الأول ١٤٤٨هـ
  { tripNumber: 9, programNumber: 1, duration: 10, nights:  9, departureDate: '١٨ أغسطس ٢٠٢٦', returnDate: '٢٧ أغسطس ٢٠٢٦', departureDateISO: '2026-08-18', returnDateISO: '2026-08-27', departureDateHijri: '٥ ربيع الأول ١٤٤٨هـ', returnDateHijri: '١٤ ربيع الأول ١٤٤٨هـ', month: 'أغسطس', haramainTrain: true,  meccaNights:  4, medinaNights: 5, medinaHotel: 'جراند بلازا',   medinaBreakfast: false, meccaHotel: 'أزكى الصفا',     meccaBreakfast: true,  priceQuad: 54500, priceTriple: 56500, priceDouble: 62700, programType: 'اقتصادي متميز' },
  { tripNumber: 9, programNumber: 2, duration: 10, nights:  9, departureDate: '١٨ أغسطس ٢٠٢٦', returnDate: '٢٧ أغسطس ٢٠٢٦', departureDateISO: '2026-08-18', returnDateISO: '2026-08-27', departureDateHijri: '٥ ربيع الأول ١٤٤٨هـ', returnDateHijri: '١٤ ربيع الأول ١٤٤٨هـ', month: 'أغسطس', haramainTrain: true,  meccaNights:  4, medinaNights: 5, medinaHotel: 'الحارثية',      medinaBreakfast: true,  meccaHotel: 'الصفوة',         meccaBreakfast: true,  priceQuad: 69500, priceTriple: 75500, priceDouble: 85000, programType: 'خمس نجوم' },
  { tripNumber: 9, programNumber: 3, duration: 10, nights:  9, departureDate: '١٨ أغسطس ٢٠٢٦', returnDate: '٢٧ أغسطس ٢٠٢٦', departureDateISO: '2026-08-18', returnDateISO: '2026-08-27', departureDateHijri: '٥ ربيع الأول ١٤٤٨هـ', returnDateHijri: '١٤ ربيع الأول ١٤٤٨هـ', month: 'أغسطس', haramainTrain: true,  meccaNights:  4, medinaNights: 5, medinaHotel: 'الحارثية',      medinaBreakfast: true,  meccaHotel: 'موفنبيك',        meccaBreakfast: true,  priceQuad: 72500, priceTriple: 78000, priceDouble: 91000, programType: 'خمس نجوم' },

  // ── Trip 10: 15 days, 26 Aug-9 Sep 2026 — ١٣ ربيع الأول ١٤٤٨هـ → ٢٧ ربيع الأول ١٤٤٨هـ
  { tripNumber: 10, programNumber: 1, duration: 15, nights: 14, departureDate: '٢٦ أغسطس ٢٠٢٦', returnDate: '٩ سبتمبر ٢٠٢٦',  departureDateISO: '2026-08-26', returnDateISO: '2026-09-09', departureDateHijri: '١٣ ربيع الأول ١٤٤٨هـ', returnDateHijri: '٢٧ ربيع الأول ١٤٤٨هـ', month: 'أغسطس', haramainTrain: false, meccaNights: 10, medinaNights: 4, medinaHotel: 'أوديست',       medinaBreakfast: false, meccaHotel: 'سنود الريان',    meccaBreakfast: false, priceQuad: 46000, priceTriple: 49100, priceDouble: 55100, programType: 'اقتصادي' },
  { tripNumber: 10, programNumber: 2, duration: 15, nights: 14, departureDate: '٢٦ أغسطس ٢٠٢٦', returnDate: '٩ سبتمبر ٢٠٢٦',  departureDateISO: '2026-08-26', returnDateISO: '2026-09-09', departureDateHijri: '١٣ ربيع الأول ١٤٤٨هـ', returnDateHijri: '٢٧ ربيع الأول ١٤٤٨هـ', month: 'أغسطس', haramainTrain: false, meccaNights: 10, medinaNights: 4, medinaHotel: 'أوديست',       medinaBreakfast: false, meccaHotel: 'رمادا',          meccaBreakfast: false, priceQuad: 53500, priceTriple: 58000, priceDouble: 68500, programType: 'اقتصادي متميز' },

  // ── Trip 11: 10 days, 1-11 Sep 2026 — ١٩ ربيع الأول ١٤٤٨هـ → ٢٩ ربيع الأول ١٤٤٨هـ
  { tripNumber: 11, programNumber: 1, duration: 10, nights:  9, departureDate: '١ سبتمبر ٢٠٢٦',  returnDate: '١١ سبتمبر ٢٠٢٦', departureDateISO: '2026-09-01', returnDateISO: '2026-09-11', departureDateHijri: '١٩ ربيع الأول ١٤٤٨هـ', returnDateHijri: '٢٩ ربيع الأول ١٤٤٨هـ', month: 'سبتمبر', haramainTrain: false, meccaNights:  5, medinaNights: 4, medinaHotel: 'جراند بلازا',   medinaBreakfast: false, meccaHotel: 'أزكى الصفا',     meccaBreakfast: true,  priceQuad: 54500, priceTriple: 57000, priceDouble: 63000, programType: 'اقتصادي متميز' },
  { tripNumber: 11, programNumber: 2, duration: 10, nights:  9, departureDate: '١ سبتمبر ٢٠٢٦',  returnDate: '١١ سبتمبر ٢٠٢٦', departureDateISO: '2026-09-01', returnDateISO: '2026-09-11', departureDateHijri: '١٩ ربيع الأول ١٤٤٨هـ', returnDateHijri: '٢٩ ربيع الأول ١٤٤٨هـ', month: 'سبتمبر', haramainTrain: false, meccaNights:  5, medinaNights: 4, medinaHotel: 'الحارثية',      medinaBreakfast: false, meccaHotel: 'الصفوة',         meccaBreakfast: false, priceQuad: 69900, priceTriple: 74900, priceDouble: 85900, programType: 'خمس نجوم' },
  { tripNumber: 11, programNumber: 3, duration: 10, nights:  9, departureDate: '١ سبتمبر ٢٠٢٦',  returnDate: '١١ سبتمبر ٢٠٢٦', departureDateISO: '2026-09-01', returnDateISO: '2026-09-11', departureDateHijri: '١٩ ربيع الأول ١٤٤٨هـ', returnDateHijri: '٢٩ ربيع الأول ١٤٤٨هـ', month: 'سبتمبر', haramainTrain: false, meccaNights:  5, medinaNights: 4, medinaHotel: 'الحارثية',      medinaBreakfast: false, meccaHotel: 'موفنبيك',        meccaBreakfast: false, priceQuad: 72500, priceTriple: 78500, priceDouble: 91000, programType: 'خمس نجوم' },
  { tripNumber: 11, programNumber: 4, duration: 10, nights:  9, departureDate: '١ سبتمبر ٢٠٢٦',  returnDate: '١١ سبتمبر ٢٠٢٦', departureDateISO: '2026-09-01', returnDateISO: '2026-09-11', departureDateHijri: '١٩ ربيع الأول ١٤٤٨هـ', returnDateHijri: '٢٩ ربيع الأول ١٤٤٨هـ', month: 'سبتمبر', haramainTrain: false, meccaNights:  5, medinaNights: 4, medinaHotel: 'أوديست',       medinaBreakfast: false, meccaHotel: 'رمادا الفائزين', meccaBreakfast: false, priceQuad: 47000, priceTriple: 50500, priceDouble: 56500, programType: 'اقتصادي متميز' },
  { tripNumber: 11, programNumber: 5, duration: 10, nights:  9, departureDate: '١ سبتمبر ٢٠٢٦',  returnDate: '١١ سبتمبر ٢٠٢٦', departureDateISO: '2026-09-01', returnDateISO: '2026-09-11', departureDateHijri: '١٩ ربيع الأول ١٤٤٨هـ', returnDateHijri: '٢٩ ربيع الأول ١٤٤٨هـ', month: 'سبتمبر', haramainTrain: false, meccaNights:  5, medinaNights: 4, medinaHotel: 'أوديست',       medinaBreakfast: false, meccaHotel: 'سنود الريان',    meccaBreakfast: false, priceQuad: 44000, priceTriple: 47000, priceDouble: 51500, programType: 'اقتصادي' },

  // ── Trip 12: 7 days, 7-13 Sep 2026 — ٢٥ ربيع الأول ١٤٤٨هـ → ٢ ربيع الثاني ١٤٤٨هـ
  { tripNumber: 12, programNumber: 1, duration:  7, nights:  6, departureDate: '٧ سبتمبر ٢٠٢٦',  returnDate: '١٣ سبتمبر ٢٠٢٦', departureDateISO: '2026-09-07', returnDateISO: '2026-09-13', departureDateHijri: '٢٥ ربيع الأول ١٤٤٨هـ', returnDateHijri: '٢ ربيع الثاني ١٤٤٨هـ', month: 'سبتمبر', haramainTrain: true,  meccaNights:  3, medinaNights: 3, medinaHotel: 'شذا ريجنسي',    medinaBreakfast: false, meccaHotel: 'الصفوة',         meccaBreakfast: true,  priceQuad: 56000, priceTriple: 59500, priceDouble: 66500, programType: 'خمس نجوم' },
  { tripNumber: 12, programNumber: 2, duration:  7, nights:  6, departureDate: '٧ سبتمبر ٢٠٢٦',  returnDate: '١٣ سبتمبر ٢٠٢٦', departureDateISO: '2026-09-07', returnDateISO: '2026-09-13', departureDateHijri: '٢٥ ربيع الأول ١٤٤٨هـ', returnDateHijri: '٢ ربيع الثاني ١٤٤٨هـ', month: 'سبتمبر', haramainTrain: true,  meccaNights:  3, medinaNights: 3, medinaHotel: 'أوديست',       medinaBreakfast: false, meccaHotel: 'أزكى الصفا',     meccaBreakfast: true,  priceQuad: 48500, priceTriple: 51000, priceDouble: 56000, programType: 'اقتصادي متميز' },
  { tripNumber: 12, programNumber: 3, duration:  7, nights:  6, departureDate: '٧ سبتمبر ٢٠٢٦',  returnDate: '١٣ سبتمبر ٢٠٢٦', departureDateISO: '2026-09-07', returnDateISO: '2026-09-13', departureDateHijri: '٢٥ ربيع الأول ١٤٤٨هـ', returnDateHijri: '٢ ربيع الثاني ١٤٤٨هـ', month: 'سبتمبر', haramainTrain: true,  meccaNights:  3, medinaNights: 3, medinaHotel: 'شذا ريجنسي',    medinaBreakfast: false, meccaHotel: 'موفنبيك',        meccaBreakfast: true,  priceQuad: 57000, priceTriple: 60500, priceDouble: 67500, programType: 'خمس نجوم' },
]

// ── Hijri month equivalents for the 3 catalog months ─────────────────────
const MONTH_HIJRI_RANGE: Record<string, string> = {
  'يوليو':   'محرم / صفر ١٤٤٨هـ',
  'أغسطس':  'صفر / ربيع الأول ١٤٤٨هـ',
  'سبتمبر': 'ربيع الأول / ربيع الثاني ١٤٤٨هـ',
}

// ── helpers ─────────────────────────────────────────────────────────────────

function fmtHijriRange(dep: string | undefined | null, ret: string | undefined | null): string {
  if (!dep || !ret) return ''
  // Compress same-month ranges: "١ صفر ١٤٤٨هـ" / "١٠ صفر ١٤٤٨هـ" → "١-١٠ صفر ١٤٤٨هـ"
  const dp = dep.split(' ')   // [day, month, year]
  const rp = ret.split(' ')
  if (dp[1] === rp[1] && dp[2] === rp[2]) {
    return `${dp[0]}-${rp[0]} ${dp[1]} ${dp[2]}`
  }
  return `${dep} إلى ${ret}`
}

function fmtDuration(d: number): string {
  return toArabicIndic(d) + (d <= 10 ? ' أيام' : ' يوم')
}

// ── main export (static path — unchanged) ────────────────────────────────────

export function buildUmrahCatalogTable(): string {
  return buildUmrahCatalogTableFromData(UMRAH_PROGRAMS_2026, HOTEL_BOOKING_LINKS)
}

// ── data-parameterised renderer (used by dynamic-catalog-builder) ─────────────

export function buildUmrahCatalogTableFromData(
  programs: UmrahProgram[],
  hotelLinks: Record<string, string>,
): string {
  const MONTHS = [...new Set(programs.map(p => p.month))]
    .sort((a, b) => {
      const order = ['يوليو', 'أغسطس', 'سبتمبر']
      return (order.indexOf(a) ?? 99) - (order.indexOf(b) ?? 99)
    })
  const TYPE_ORDER: ProgramType[] = ['اقتصادي', 'اقتصادي متميز', 'خمس نجوم']

  const availLines = MONTHS.map(m => {
    const types = [...new Set(
      programs.filter(p => p.month === m).map(p => p.programType),
    )].sort((a, b) => TYPE_ORDER.indexOf(a) - TYPE_ORDER.indexOf(b))
    const hijri = MONTH_HIJRI_RANGE[m] ?? ''
    return `${m} ٢٠٢٦م (${hijri}): ${types.join(' و ')}`
  })

  const linksBlock = Object.entries(hotelLinks)
    .map(([hotel, url]) => `${hotel}: ${url}`)
    .join('\n')

  const header = `## القسم ٣أ — برامج العمرة ٢٠٢٦ (الأسعار بالجنيه للفرد — اقرأ هذا القسم كاملاً قبل الرد)

ملخص التوافر السريع (حسب المستوى):
${availLines.join('\n')}

تعليمة الأسعار: اعرض دايماً أسعار الثلاث تسكنات (رباعي + ثلاثي + ثنائي) لكل برنامج بغض النظر عن عدد الأفراد — العميل هو الذي يختار نوع الغرفة
لو ذكر العدد: اعرض الثلاث أسعار للفرد أولاً ثم أضف ثلاث إجماليات (رباعي × عدد) و(ثلاثي × عدد) و(ثنائي × عدد)

## روابط مراجعة الفنادق — استخدمها عند عرض أي برنامج بعد اسم الفندق
${linksBlock}`

  const tableHeader =
    '| المستوى | المدة | التواريخ الميلادية | التواريخ الهجرية | فندق مكة | فندق المدينة | إفطار مكة | إفطار المدينة | قطار الحرمين | رباعي | ثلاثي | ثنائي |'
  const tableSep =
    '|---------|-------|---------|---------|---------|-------------|-----------|----------------|--------------|-------|-------|-------|'

  const sections: string[] = [header]

  for (const month of MONTHS) {
    const progs = programs
      .filter(p => p.month === month)
      .sort((a, b) =>
        TYPE_ORDER.indexOf(a.programType) - TYPE_ORDER.indexOf(b.programType) ||
        a.tripNumber - b.tripNumber ||
        a.programNumber - b.programNumber,
      )

    if (progs.length === 0) continue

    const hijri = MONTH_HIJRI_RANGE[month] ?? ''
    sections.push(`\n### برامج ${month} ٢٠٢٦م (${hijri})\n`)
    sections.push(tableHeader)
    sections.push(tableSep)

    for (const p of progs) {
      const row = [
        p.programType,
        fmtDuration(p.duration),
        `${p.departureDate.split(' ')[0]}-${p.returnDate.split(' ')[0]} ${p.returnDate.split(' ')[1]} ${p.returnDate.split(' ')[2]}م`,
        fmtHijriRange(p.departureDateHijri, p.returnDateHijri),
        p.meccaHotel,
        p.medinaHotel,
        p.meccaBreakfast  ? 'نعم' : 'لا',
        p.medinaBreakfast ? 'نعم' : 'لا',
        p.haramainTrain   ? 'نعم' : 'لا',
        formatPrice(p.priceQuad),
        formatPrice(p.priceTriple),
        formatPrice(p.priceDouble),
      ]
      sections.push('| ' + row.join(' | ') + ' |')
    }
  }

  return sections.join('\n')
}
