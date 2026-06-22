export interface HotelEntry {
  name: string;
  stars: string;
  location: string;
  distance: string;
  highlight: string;
  rating: string;
  link: string;
  keywords: string[];
}

export const HOTELS: HotelEntry[] = [
  {
    name: 'موفنبيك برج هاجر',
    stars: '٦ نجوم',
    location: 'مكة المكرمة',
    distance: 'أقل من دقيقة مشياً للحرم بممرات مكيفة وإطلالة مباشرة على الكعبة',
    highlight: 'موقع استثنائي ملاصق للحرم وإطلالة على الكعبة من الغرفة',
    rating: '٩٫٣ من ١٠',
    link: 'https://www.booking.com/Share-zYAacjf',
    keywords: ['موفنبيك', 'برج هاجر'],
  },
  {
    name: 'أذكي الصفا',
    stars: '٥ نجوم',
    location: 'شارع أجياد مكة المكرمة',
    distance: 'حوالي ١٥٠-٣٠٠ متر من المسجد الحرام',
    highlight: 'قريب من الحرم وأسعار معقولة مقارنة بتصنيفه',
    rating: '٧٫٢ من ١٠',
    link: 'https://www.booking.com/hotel/sa/azka-al-safa.ar.html',
    keywords: ['أذكي الصفا', 'أزكى الصفا', 'ازكي الصفا'],
  },
  {
    name: 'الصفوة',
    stars: '٣ نجوم',
    location: 'منطقة بوابة الملك عبدالعزيز مكة المكرمة',
    distance: 'حوالي ٩٥٠ متر من المسجد الحرام',
    highlight: 'موقع مريح ونظافة ممتازة وقيمة ممتازة مقارنة بالسعر — تقييم ٩٫٢ للأزواج',
    rating: '٩٫٢ من ١٠',
    link: 'https://www.booking.com/Share-8hDcymv',
    keywords: ['الصفوة', 'صفوة'],
  },
  {
    name: 'رمادا دار الفائزين',
    stars: '٤ نجوم',
    location: 'شارع أجياد مكة المكرمة',
    distance: '٣٠٠-٥٠٠ متر من الحرم (٥ دقائق مشياً)',
    highlight: 'خدمة ممتازة وبوفيه إفطار جيد ومناسب للعائلات',
    rating: '٨ من ١٠',
    link: 'https://www.trivago.com/share/ShwM6UtJbZ',
    keywords: ['رمادا', 'دار الفائزين'],
  },
  {
    name: 'سنود الريان',
    stars: '٢ نجوم',
    location: 'مكة المكرمة',
    distance: 'حوالي ٣ دقائق بالسيارة من الحرم مع خدمة توصيل مجانية',
    highlight: 'طاقم عمل ممتاز وخدمة نقل مجانية للحرم وسعر اقتصادي',
    rating: '٧٫٧ من ١٠',
    link: 'https://sa.trip.com/hotels/makkah-hotel-detail-81468178/snood-al-rayyan-hotel/',
    keywords: ['سنود', 'الريان', 'سنود الريان'],
  },
  {
    name: 'فرونتيل الحارثية',
    stars: '٤ نجوم',
    location: 'منطقة الحارثية المدينة المنورة',
    distance: '٥ دقائق مشياً من الروضة الشريفة مع إطلالة مباشرة على المسجد النبوي',
    highlight: 'إطلالة رائعة على الحرم النبوي ونظافة عالية وخدمة راقية',
    rating: '٤ من ٥ (ترتيب ١٤ من ٢٥٦ فندق في المدينة)',
    link: 'https://www.booking.com/Share-gFleQHr',
    keywords: ['الحارثية', 'فرونتيل', 'فرونتيل الحارثية'],
  },
  {
    name: 'إعمار المنار',
    stars: '٦ نجوم',
    location: 'وسط المدينة المنورة',
    distance: 'حوالي ١٠٠-١٨٠ متر من المسجد النبوي',
    highlight: 'قريب جداً من النبوي وغرف واسعة وبوفيه إفطار متميز',
    rating: '٨٫٢ من ١٠',
    link: 'https://www.booking.com/Share-jCPBIDW',
    keywords: ['إعمار', 'اعمار', 'المنار', 'إعمار المنار'],
  },
  {
    name: 'جراند بلازا المدينة',
    stars: '',
    location: 'المدينة المنورة',
    distance: '٦٠٠-٧٠٠ متر من المسجد النبوي الشريف',
    highlight: 'موقع ممتاز وخدمة ودية ومناسب للعائلات والمجموعات',
    rating: '',
    link: 'https://www.booking.com/Share-t752OEg',
    keywords: ['جراند بلازا', 'جراند'],
  },
  {
    name: 'شذا ريجنسي بلازا',
    stars: '٣ نجوم',
    location: 'قلب المدينة المنورة',
    distance: '٣ دقائق مشياً من المسجد النبوي',
    highlight: 'موقع مثالي قريب جداً من الحرم النبوي وسعر مناسب',
    rating: '',
    link: 'https://www.booking.com/Share-3JCkDA',
    keywords: ['شذا', 'ريجنسي', 'شذا ريجنسي'],
  },
  {
    name: 'أوديست المدينة',
    stars: '',
    location: 'المدينة المنورة',
    distance: 'حوالي ١٠ دقائق مشياً من المسجد النبوي',
    highlight: 'خيار اقتصادي ممتاز لمن يفضل توفير ميزانية أكبر للتسوق',
    rating: '',
    link: 'https://www.booking.com/Share-cGbCMAy',
    keywords: ['أوديست', 'اوديست'],
  },
];

export function findHotelInMessage(message: string): string | null {
  return findHotelInMessageFromData(message, HOTELS);
}

export function findHotelInMessageFromData(message: string, hotels: HotelEntry[]): string | null {
  const normalized = message.toLowerCase();
  for (const hotel of hotels) {
    for (const kw of hotel.keywords) {
      if (normalized.includes(kw.toLowerCase())) {
        const starsStr = hotel.stars ? ` ${hotel.stars}` : '';
        const ratingStr = hotel.rating ? ` تقييم: ${hotel.rating}` : '';
        return `[تعليمة: العميل سأل بالاسم عن فندق "${hotel.name}" — ارد بهذه المعلومات مباشرة بدون أسئلة متابعة]
فندق: ${hotel.name}${starsStr}
الموقع: ${hotel.location}
المسافة من الحرم: ${hotel.distance}
أبرز ميزة: ${hotel.highlight}${ratingStr}
رابط الحجز: ${hotel.link}`;
      }
    }
  }
  return null;
}

export function buildHotelKnowledge(): string {
  return buildHotelKnowledgeFromData(HOTELS)
}

export function buildHotelKnowledgeFromData(hotels: HotelEntry[]): string {
  const mecca  = hotels.filter(h => !h.location.includes('المدينة المنورة'))
  const medina = hotels.filter(h => h.location.includes('المدينة المنورة'))

  function renderHotel(h: HotelEntry): string {
    const header = h.stars ? `${h.name} (${h.stars}):` : `${h.name}:`
    const lines: string[] = [header, `- المسافة: ${h.distance}`]
    if (h.highlight) lines.push(`- آراء العملاء: ${h.highlight}`)
    if (h.rating)    lines.push(`- تقييم: ${h.rating}`)
    lines.push(`- رابط الحجز: ${h.link}`)
    return lines.join('\n')
  }

  const meccaBlock  = mecca.map(renderHotel).join('\n\n')
  const medinaBlock = medina.map(renderHotel).join('\n\n')

  return `## قسم الفنادق (مرجع البحث)
لا تذكر هذا القسم تلقائياً إلا عند السؤال عن فندق معين

─── فنادق مكة المكرمة ───

${meccaBlock}

─── فنادق المدينة المنورة ───

${medinaBlock}`
}
