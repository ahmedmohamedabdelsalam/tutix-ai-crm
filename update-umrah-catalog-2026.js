require('dotenv').config();
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');
const { PrismaClient } = require('@prisma/client');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const ALEX_COMPANY_ID = 'cmq4ok7hx000004kzfnsxp54o';

// ── Booking links keyed by short Arabic hotel name ──────────────────────────
const BOOKING_LINKS = {
  'أوديست':         'https://www.booking.com/Share-cGbCMAy',
  'سنود الريان':    'https://sa.trip.com/hotels/makkah-hotel-detail-81468178/snood-al-rayyan-hotel/',
  'إعمار المنار':   'https://www.booking.com/Share-jCPBIDW',
  'أزكى الصفا':     'https://www.google.com/aclk?sa=L&ai=DChsSEwjTnNGfh4CVAxVpg3wGHSJ_JX0YACICCAEQABoCd3M&co=1&gclid=CjwKCAjwuanRBhBSEiwAY5y6V6nzpLJUUHF3VI7gdzu-VUcc5SElm_sXkJKTYF3tto6W4im6n6ZG5hoCGggQAvD_BwE',
  'الصفوة':         'https://www.booking.com/Share-8hDcymv',
  'الحارثي':        'https://www.booking.com/Share-gFleQHr',
  'جراند بلازا':    'https://www.booking.com/Share-t752OEg',
  'موفنبيك':        'https://www.booking.com/Share-zYAacjf',
  'شزا ريجنسي':     'https://www.booking.com/Share-3JCkDA',
  'شزا':            'https://www.booking.com/Share-3JCkDA',
  'رامادا الفايزين':'https://www.trivago.com/share/ShwM6UtJbZ',
  'رامادا':         'https://www.trivago.com/share/ShwM6UtJbZ',
};

// New hotels not in the original list — add if missing
const NEW_HOTEL_DEFAULTS = {
  'شزا ريجنسي':      { city: 'المدينة المنورة', stars: 5, note: 'فندق شزا ريجنسي - المدينة المنورة' },
  'شزا':             { city: 'المدينة المنورة', stars: 5, note: 'فندق شزا - المدينة المنورة' },
  'رامادا الفايزين': { city: 'مكة المكرمة',     stars: 4, note: 'فندق رامادا الفايزين - مكة المكرمة' },
  'سنود الريان':     { city: 'مكة المكرمة',     stars: 4, note: 'فندق سنود الريان - مكة المكرمة' },
  'سنود الويان':     { city: 'مكة المكرمة',     stars: 4, note: 'فندق سنود الويان - مكة المكرمة' },
  'إعمار المنار':    { city: 'مكة المكرمة',     stars: 5, note: 'فندق إعمار المنار - مكة المكرمة' },
  'أزكى الصفا':      { city: 'مكة المكرمة',     stars: 4, note: 'فندق أزكى الصفا - مكة المكرمة' },
};

// ── 25 Umrah programs: 10 trips × multiple room-type variants ───────────────
const NEW_UMRAH_PROGRAMS = [

  // ─── TRIP 1: 15 days  Jul 26 – Aug 9  (Private flight, no Haramain) ──────
  {
    id: 'trip1a-jul26-aug9-economy',
    name: 'عمرة يوليو ١٥ يوم - اقتصادي (أوديست / سنود الريان)',
    departureDate: '2026-07-26', returnDate: '2026-08-09',
    nights: 14, madinahNights: 4, makkahNights: 10,
    airline: 'رحلة خاصة',
    route: 'القاهرة / المدينة المنورة / جدة / القاهرة',
    haramainTrain: false,
    madinahHotel: 'أوديست',    madinahBreakfast: false,
    makkahHotel:  'سنود الريان', makkahBreakfast: false,
    quadPrice: 40500, triplePrice: 43500, doublePrice: 49000,
  },
  {
    id: 'trip1b-jul26-aug9-economy-plus',
    name: 'عمرة يوليو ١٥ يوم - اقتصادي متميز (أوديست / سنود الريان)',
    departureDate: '2026-07-26', returnDate: '2026-08-09',
    nights: 14, madinahNights: 4, makkahNights: 10,
    airline: 'رحلة خاصة',
    route: 'القاهرة / المدينة المنورة / جدة / القاهرة',
    haramainTrain: false,
    madinahHotel: 'أوديست',    madinahBreakfast: false,
    makkahHotel:  'سنود الريان', makkahBreakfast: false,
    quadPrice: 45000, triplePrice: 48500, doublePrice: 54000,
  },
  {
    id: 'trip1c-jul26-aug9-5star',
    name: 'عمرة يوليو ١٥ يوم - خمس نجوم (أوديست / إعمار المنار)',
    departureDate: '2026-07-26', returnDate: '2026-08-09',
    nights: 14, madinahNights: 4, makkahNights: 10,
    airline: 'رحلة خاصة',
    route: 'القاهرة / المدينة المنورة / جدة / القاهرة',
    haramainTrain: false,
    madinahHotel: 'أوديست',      madinahBreakfast: false,
    makkahHotel:  'إعمار المنار', makkahBreakfast: true,
    quadPrice: 53500, triplePrice: 57900, doublePrice: 65500,
  },

  // ─── TRIP 2: 10 days  Jul 26 – Aug 4  (Saudi Airlines + Haramain) ────────
  {
    id: 'trip2a-jul26-aug4-economy',
    name: 'عمرة يوليو ١٠ أيام - اقتصادي (جراند بلازا / أزكى الصفا)',
    departureDate: '2026-07-26', returnDate: '2026-08-04',
    nights: 9, madinahNights: 4, makkahNights: 5,
    airline: 'السعودية',
    route: 'القاهرة / المدينة المنورة / جدة / القاهرة',
    haramainTrain: true,
    madinahHotel: 'جراند بلازا', madinahBreakfast: false,
    makkahHotel:  'أزكى الصفا',  makkahBreakfast: true,
    quadPrice: 53000, triplePrice: 56200, doublePrice: 62500,
  },
  {
    id: 'trip2b-jul26-aug4-luxury',
    name: 'عمرة يوليو ١٠ أيام - فاخر (الحارثي / الصفوة)',
    departureDate: '2026-07-26', returnDate: '2026-08-04',
    nights: 9, madinahNights: 4, makkahNights: 5,
    airline: 'السعودية',
    route: 'القاهرة / المدينة المنورة / جدة / القاهرة',
    haramainTrain: true,
    madinahHotel: 'الحارثي', madinahBreakfast: true,
    makkahHotel:  'الصفوة',  makkahBreakfast: true,
    quadPrice: 67500, triplePrice: 72000, doublePrice: 81000,
  },
  {
    id: 'trip2c-jul26-aug4-5star',
    name: 'عمرة يوليو ١٠ أيام - خمس نجوم (الحارثي / موفنبيك)',
    departureDate: '2026-07-26', returnDate: '2026-08-04',
    nights: 9, madinahNights: 4, makkahNights: 5,
    airline: 'السعودية',
    route: 'القاهرة / المدينة المنورة / جدة / القاهرة',
    haramainTrain: true,
    madinahHotel: 'الحارثي', madinahBreakfast: true,
    makkahHotel:  'موفنبيك', makkahBreakfast: true,
    quadPrice: 70500, triplePrice: 75500, doublePrice: 85500,
  },

  // ─── TRIP 3: 11 days  Jul 26 – Aug 5  (Saudi Airlines, no Haramain) ──────
  {
    id: 'trip3a-jul26-aug5-economy',
    name: 'عمرة يوليو ١١ يوم - اقتصادي (أوديست / رامادا الفايزين)',
    departureDate: '2026-07-26', returnDate: '2026-08-05',
    nights: 10, madinahNights: 4, makkahNights: 6,
    airline: 'السعودية',
    route: 'القاهرة / المدينة المنورة / جدة / القاهرة',
    haramainTrain: false,
    madinahHotel: 'أوديست',        madinahBreakfast: false,
    makkahHotel:  'رامادا الفايزين', makkahBreakfast: false,
    quadPrice: 46500, triplePrice: 50500, doublePrice: 57200,
  },

  // ─── TRIP 4: 11 days  Aug 5 – Aug 15  (Saudi Airlines, no Haramain) ──────
  {
    id: 'trip4a-aug5-aug15-5star',
    name: 'عمرة أغسطس ١١ يوم - خمس نجوم (أوديست / إعمار المنار)',
    departureDate: '2026-08-05', returnDate: '2026-08-15',
    nights: 10, madinahNights: 4, makkahNights: 6,
    airline: 'السعودية',
    route: 'القاهرة / جدة / المدينة المنورة / القاهرة',
    haramainTrain: false,
    madinahHotel: 'أوديست',      madinahBreakfast: false,
    makkahHotel:  'إعمار المنار', makkahBreakfast: true,
    quadPrice: 48700, triplePrice: 52000, doublePrice: 57500,
  },

  // ─── TRIP 5: 7 days  Aug 10 – Aug 16  (Saudi Airlines + Haramain) ────────
  {
    id: 'trip5a-aug10-aug16-luxury',
    name: 'عمرة أغسطس ٧ أيام - فاخر (شزا ريجنسي / الصفوة)',
    departureDate: '2026-08-10', returnDate: '2026-08-16',
    nights: 6, madinahNights: 3, makkahNights: 3,
    airline: 'السعودية',
    route: 'القاهرة / المدينة المنورة / جدة / القاهرة',
    haramainTrain: true,
    madinahHotel: 'شزا ريجنسي', madinahBreakfast: false,
    makkahHotel:  'الصفوة',      makkahBreakfast: true,
    quadPrice: 56000, triplePrice: 59000, doublePrice: 66000,
  },
  {
    id: 'trip5b-aug10-aug16-5star',
    name: 'عمرة أغسطس ٧ أيام - خمس نجوم (شزا / موفنبيك)',
    departureDate: '2026-08-10', returnDate: '2026-08-16',
    nights: 6, madinahNights: 3, makkahNights: 3,
    airline: 'السعودية',
    route: 'القاهرة / المدينة المنورة / جدة / القاهرة',
    haramainTrain: true,
    madinahHotel: 'شزا',    madinahBreakfast: false,
    makkahHotel:  'موفنبيك', makkahBreakfast: true,
    quadPrice: 57000, triplePrice: 61500, doublePrice: 68500,
  },
  {
    id: 'trip5c-aug10-aug16-economy',
    name: 'عمرة أغسطس ٧ أيام - اقتصادي (أوديست / أزكى الصفا)',
    departureDate: '2026-08-10', returnDate: '2026-08-16',
    nights: 6, madinahNights: 3, makkahNights: 3,
    airline: 'السعودية',
    route: 'القاهرة / المدينة المنورة / جدة / القاهرة',
    haramainTrain: true,
    madinahHotel: 'أوديست',   madinahBreakfast: false,
    makkahHotel:  'أزكى الصفا', makkahBreakfast: true,
    quadPrice: 48000, triplePrice: 50500, doublePrice: 55000,
  },

  // ─── TRIP 6: 11 days  Aug 12 – Aug 22  (Saudi Airlines, no Haramain) ─────
  {
    id: 'trip6a-aug12-aug22-economy',
    name: 'عمرة أغسطس ١١ يوم - اقتصادي (أوديست / رامادا الفايزين)',
    departureDate: '2026-08-12', returnDate: '2026-08-22',
    nights: 10, madinahNights: 4, makkahNights: 6,
    airline: 'السعودية',
    route: 'القاهرة / المدينة المنورة / جدة / القاهرة',
    haramainTrain: false,
    madinahHotel: 'أوديست',        madinahBreakfast: false,
    makkahHotel:  'رامادا الفايزين', makkahBreakfast: false,
    quadPrice: 48000, triplePrice: 51900, doublePrice: 59900,
  },

  // ─── TRIP 7: 10 days  Aug 18 – Aug 27  (Saudi Airlines + Haramain) ───────
  {
    id: 'trip7a-aug18-aug27-economy',
    name: 'عمرة أغسطس ١٠ أيام - اقتصادي (جراند بلازا / أزكى الصفا)',
    departureDate: '2026-08-18', returnDate: '2026-08-27',
    nights: 9, madinahNights: 5, makkahNights: 4,
    airline: 'السعودية',
    route: 'القاهرة / جدة / المدينة المنورة / القاهرة',
    haramainTrain: true,
    madinahHotel: 'جراند بلازا', madinahBreakfast: false,
    makkahHotel:  'أزكى الصفا',  makkahBreakfast: true,
    quadPrice: 53500, triplePrice: 56000, doublePrice: 62000,
  },
  {
    id: 'trip7b-aug18-aug27-luxury',
    name: 'عمرة أغسطس ١٠ أيام - فاخر (الحارثي / الصفوة)',
    departureDate: '2026-08-18', returnDate: '2026-08-27',
    nights: 9, madinahNights: 5, makkahNights: 4,
    airline: 'السعودية',
    route: 'القاهرة / جدة / المدينة المنورة / القاهرة',
    haramainTrain: true,
    madinahHotel: 'الحارثي', madinahBreakfast: true,
    makkahHotel:  'الصفوة',  makkahBreakfast: true,
    quadPrice: 69500, triplePrice: 74500, doublePrice: 84500,
  },
  {
    id: 'trip7c-aug18-aug27-5star',
    name: 'عمرة أغسطس ١٠ أيام - خمس نجوم (الحارثي / موفنبيك)',
    departureDate: '2026-08-18', returnDate: '2026-08-27',
    nights: 9, madinahNights: 5, makkahNights: 4,
    airline: 'السعودية',
    route: 'القاهرة / جدة / المدينة المنورة / القاهرة',
    haramainTrain: true,
    madinahHotel: 'الحارثي', madinahBreakfast: true,
    makkahHotel:  'موفنبيك', makkahBreakfast: true,
    quadPrice: 71500, triplePrice: 76500, doublePrice: 91000,
  },

  // ─── TRIP 8: 15 days  Aug 26 – Sep 9  (Saudi Airlines, no Haramain) ──────
  {
    id: 'trip8a-aug26-sep9-economy',
    name: 'عمرة أغسطس ١٥ يوم - اقتصادي (أوديست / سنود الريان)',
    departureDate: '2026-08-26', returnDate: '2026-09-09',
    nights: 14, madinahNights: 4, makkahNights: 10,
    airline: 'السعودية',
    route: 'القاهرة / المدينة المنورة / جدة / القاهرة',
    haramainTrain: false,
    madinahHotel: 'أوديست',    madinahBreakfast: false,
    makkahHotel:  'سنود الريان', makkahBreakfast: false,
    quadPrice: 46000, triplePrice: 49100, doublePrice: 55100,
  },
  {
    id: 'trip8b-aug26-sep9-economy-plus',
    name: 'عمرة أغسطس ١٥ يوم - اقتصادي متميز (أوديست / رامادا)',
    departureDate: '2026-08-26', returnDate: '2026-09-09',
    nights: 14, madinahNights: 4, makkahNights: 10,
    airline: 'السعودية',
    route: 'القاهرة / المدينة المنورة / جدة / القاهرة',
    haramainTrain: false,
    madinahHotel: 'أوديست', madinahBreakfast: false,
    makkahHotel:  'رامادا',  makkahBreakfast: false,
    quadPrice: 52000, triplePrice: 57500, doublePrice: 67500,
  },

  // ─── TRIP 9: 10 days  Sep 1 – Sep 10  (Saudi Airlines, mixed Haramain) ───
  {
    id: 'trip9a-sep1-sep10-economy-haramain',
    name: 'عمرة سبتمبر ١٠ أيام - اقتصادي + قطار (جراند بلازا / أزكى الصفا)',
    departureDate: '2026-09-01', returnDate: '2026-09-10',
    nights: 9, madinahNights: 4, makkahNights: 5,
    airline: 'السعودية',
    route: 'القاهرة / المدينة المنورة / جدة / القاهرة',
    haramainTrain: true,
    madinahHotel: 'جراند بلازا', madinahBreakfast: false,
    makkahHotel:  'أزكى الصفا',  makkahBreakfast: false,
    quadPrice: 54500, triplePrice: 57000, doublePrice: 63000,
  },
  {
    id: 'trip9b-sep1-sep10-luxury-haramain',
    name: 'عمرة سبتمبر ١٠ أيام - فاخر + قطار (الحارثي / الصفوة)',
    departureDate: '2026-09-01', returnDate: '2026-09-10',
    nights: 9, madinahNights: 4, makkahNights: 5,
    airline: 'السعودية',
    route: 'القاهرة / المدينة المنورة / جدة / القاهرة',
    haramainTrain: true,
    madinahHotel: 'الحارثي', madinahBreakfast: true,
    makkahHotel:  'الصفوة',  makkahBreakfast: true,
    quadPrice: 69900, triplePrice: 74900, doublePrice: 85900,
  },
  {
    id: 'trip9c-sep1-sep10-5star-haramain',
    name: 'عمرة سبتمبر ١٠ أيام - خمس نجوم + قطار (الحارثي / موفنبيك)',
    departureDate: '2026-09-01', returnDate: '2026-09-10',
    nights: 9, madinahNights: 4, makkahNights: 5,
    airline: 'السعودية',
    route: 'القاهرة / المدينة المنورة / جدة / القاهرة',
    haramainTrain: true,
    madinahHotel: 'الحارثي', madinahBreakfast: true,
    makkahHotel:  'موفنبيك', makkahBreakfast: true,
    quadPrice: 72500, triplePrice: 78500, doublePrice: 91000,
  },
  {
    id: 'trip9d-sep1-sep10-economy-noharamain',
    name: 'عمرة سبتمبر ١٠ أيام - اقتصادي بدون قطار (أوديست / رامادا الفايزين)',
    departureDate: '2026-09-01', returnDate: '2026-09-10',
    nights: 9, madinahNights: 4, makkahNights: 5,
    airline: 'السعودية',
    route: 'القاهرة / المدينة المنورة / جدة / القاهرة',
    haramainTrain: false,
    madinahHotel: 'أوديست',        madinahBreakfast: false,
    makkahHotel:  'رامادا الفايزين', makkahBreakfast: false,
    quadPrice: 47000, triplePrice: 50500, doublePrice: 56500,
  },
  {
    id: 'trip9e-sep1-sep10-economy-noharamain-snood',
    name: 'عمرة سبتمبر ١٠ أيام - اقتصادي بدون قطار (أوديست / سنود الويان)',
    departureDate: '2026-09-01', returnDate: '2026-09-10',
    nights: 9, madinahNights: 4, makkahNights: 5,
    airline: 'السعودية',
    route: 'القاهرة / المدينة المنورة / جدة / القاهرة',
    haramainTrain: false,
    madinahHotel: 'أوديست',    madinahBreakfast: false,
    makkahHotel:  'سنود الويان', makkahBreakfast: false,
    quadPrice: 44000, triplePrice: 47000, doublePrice: 51500,
  },

  // ─── TRIP 10: 7 days  Sep 7 – Sep 13  (Saudi Airlines + Haramain) ────────
  {
    id: 'trip10a-sep7-sep13-luxury',
    name: 'عمرة سبتمبر ٧ أيام - فاخر (شزا ريجنسي / الصفوة)',
    departureDate: '2026-09-07', returnDate: '2026-09-13',
    nights: 6, madinahNights: 3, makkahNights: 3,
    airline: 'السعودية',
    route: 'القاهرة / المدينة المنورة / جدة / القاهرة',
    haramainTrain: true,
    madinahHotel: 'شزا ريجنسي', madinahBreakfast: false,
    makkahHotel:  'الصفوة',      makkahBreakfast: true,
    quadPrice: 56000, triplePrice: 59500, doublePrice: 66500,
  },
  {
    id: 'trip10b-sep7-sep13-economy',
    name: 'عمرة سبتمبر ٧ أيام - اقتصادي (أوديست / أزكى الصفا)',
    departureDate: '2026-09-07', returnDate: '2026-09-13',
    nights: 6, madinahNights: 3, makkahNights: 3,
    airline: 'السعودية',
    route: 'القاهرة / المدينة المنورة / جدة / القاهرة',
    haramainTrain: true,
    madinahHotel: 'أوديست',   madinahBreakfast: false,
    makkahHotel:  'أزكى الصفا', makkahBreakfast: true,
    quadPrice: 51000, triplePrice: 56000, doublePrice: 56000,
  },
  {
    id: 'trip10c-sep7-sep13-5star',
    name: 'عمرة سبتمبر ٧ أيام - خمس نجوم (شزا / موفنبيك)',
    departureDate: '2026-09-07', returnDate: '2026-09-13',
    nights: 6, madinahNights: 3, makkahNights: 3,
    airline: 'السعودية',
    route: 'القاهرة / المدينة المنورة / جدة / القاهرة',
    haramainTrain: true,
    madinahHotel: 'شزا',    madinahBreakfast: false,
    makkahHotel:  'موفنبيك', makkahBreakfast: true,
    quadPrice: 57000, triplePrice: 60500, doublePrice: 67500,
  },
];

// ────────────────────────────────────────────────────────────────────────────
async function main() {
  // 1. Read current config
  const config = await prisma.companyAIConfig.findUnique({
    where: { companyId: ALEX_COMPANY_ID },
  });
  if (!config) throw new Error('CompanyAIConfig not found for Alex');

  const cat = config.catalog;
  const ind = config.industryData;

  console.log('=== BEFORE ===');
  console.log('umrahPrograms:', cat.umrahPrograms?.length ?? 0);
  console.log('hajjPrograms: ', cat.hajjPrograms?.length ?? 0);
  console.log('hotels:       ', ind.hotels?.length ?? 0);

  // 2. Build new catalog — replace umrah, keep hajj
  const newCatalog = {
    ...cat,
    umrahPrograms: NEW_UMRAH_PROGRAMS,
  };

  // 3. Update hotels: add bookingLink to existing, append missing
  let hotels = JSON.parse(JSON.stringify(ind.hotels ?? []));

  // Add booking links to existing hotels by name
  hotels = hotels.map(h => {
    const link = BOOKING_LINKS[h.name];
    return link ? { ...h, bookingLink: link } : h;
  });

  // Append hotels that are in NEW_HOTEL_DEFAULTS but not yet in the list
  const existingNames = new Set(hotels.map(h => h.name));
  for (const [name, meta] of Object.entries(NEW_HOTEL_DEFAULTS)) {
    if (!existingNames.has(name)) {
      const entry = { name, ...meta };
      if (BOOKING_LINKS[name]) entry.bookingLink = BOOKING_LINKS[name];
      hotels.push(entry);
      console.log(`  Added new hotel: ${name}`);
    }
  }

  // 4. Add price note to industryData
  const newIndustryData = {
    ...ind,
    hotels,
    priceNote: 'جميع الأسعار تتوقف على ضوابط الوزارة، إما بالتأكيد أو التحريك البسيط',
  };

  // 5. Write to DB
  await prisma.companyAIConfig.update({
    where: { companyId: ALEX_COMPANY_ID },
    data: { catalog: newCatalog, industryData: newIndustryData },
  });

  // 6. Verify
  const updated = await prisma.companyAIConfig.findUnique({
    where: { companyId: ALEX_COMPANY_ID },
  });
  const updCat = updated.catalog;
  const updInd = updated.industryData;

  const first = updCat.umrahPrograms?.[0];
  const last  = updCat.umrahPrograms?.[updCat.umrahPrograms.length - 1];
  const hotelsWithLinks = (updInd.hotels ?? []).filter(h => h.bookingLink);

  console.log('\n=== AFTER ===');
  console.log('1. umrahPrograms count:   ', updCat.umrahPrograms?.length);
  console.log('2. hajjPrograms count:    ', updCat.hajjPrograms?.length, '(unchanged)');
  console.log('\n3. First program:');
  console.log('   name:   ', first?.name);
  console.log('   quad:   ', first?.quadPrice, '| triple:', first?.triplePrice, '| double:', first?.doublePrice);
  console.log('\n4. Last program:');
  console.log('   name:   ', last?.name);
  console.log('   quad:   ', last?.quadPrice, '| triple:', last?.triplePrice, '| double:', last?.doublePrice);
  console.log('\n5. Hotels with booking links:', hotelsWithLinks.length, '/', updInd.hotels?.length);
  hotelsWithLinks.forEach(h => console.log(`   ${h.name}: ${h.bookingLink.substring(0, 55)}...`));
  console.log('\n   priceNote:', updInd.priceNote);

  console.log('\n✅ Done');
}

main()
  .catch(console.error)
  .finally(async () => { await prisma.$disconnect(); await pool.end(); });
