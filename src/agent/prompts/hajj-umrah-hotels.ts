export interface HotelEntry {
  name: string;
  stars: string;
  location: string;
  distance: string;
  highlight: string;
  rating: string;
  link: string;
  keywords: string[];
  /**
   * Where the distance came from. 'unknown' means nobody has ever confirmed it —
   * which is the honest state of every value migrated out of this file, since no
   * source comment, data file or commit message ever recorded one.
   *
   * A distance is a customer-facing factual claim that arrives through
   * deterministic handlers, so it never passes scanModelOutput. Provenance is the
   * only thing standing between an unverified number and a customer who books on it.
   */
  distanceSource?: 'client' | 'booking.com' | 'measured' | 'unknown' | null;
  distanceConfirmedBy?: string | null;
  distanceConfirmedAt?: string | null;
}

/**
 * Only a distance someone has taken responsibility for may be stated.
 * Absent provenance is treated exactly like 'unknown' — a value that predates the
 * provenance fields is not thereby trustworthy.
 */
export function isDistanceConfirmed(h: Pick<HotelEntry, 'distance' | 'distanceSource'>): boolean {
  if (!String(h.distance ?? '').trim()) return false;
  return !!h.distanceSource && h.distanceSource !== 'unknown';
}

// The hardcoded HOTELS array lived here until 2026-08-07. It is gone deliberately:
// the live path reads CompanyAIConfig.industryData.hotels, and keeping a second
// copy in code guaranteed the two would drift with no way to tell which was right.
// Per-company DB config is now the single source. See scripts/hotel-provenance-migrate.js.

// Returns the matched HotelEntry (or null) — used by the hotel-distance handler for direct reply.
export function lookupHotelEntry(message: string, hotels: HotelEntry[]): HotelEntry | null {
  const normalized = message.toLowerCase();
  for (const hotel of hotels) {
    for (const kw of (hotel.keywords ?? [])) {
      if (normalized.includes(kw.toLowerCase())) return hotel;
    }
  }
  return null;
}

export function findHotelInMessageFromData(message: string, hotels: HotelEntry[]): string | null {
  const normalized = message.toLowerCase();
  for (const hotel of hotels) {
    for (const kw of (hotel.keywords ?? [])) {
      if (normalized.includes(kw.toLowerCase())) {
        const starsStr    = hotel.stars     ? ` ${hotel.stars}`            : '';
        const ratingStr   = hotel.rating    ? ` تقييم: ${hotel.rating}`    : '';
        const location    = hotel.location  ?? (hotel as any).city ?? '';
        // Unconfirmed distances are withheld from the model too. This block tells it
        // to state the contents directly, so leaving the number in would route an
        // unverified fact to the customer through the model instead of the handler.
        const distance    = isDistanceConfirmed(hotel) ? (hotel.distance ?? '') : '';
        const highlight   = hotel.highlight ?? '';
        const link        = hotel.link      ?? (hotel as any).bookingLink ?? '';
        const distanceLine = distance
          ? `المسافة من الحرم: ${distance}`
          : 'المسافة من الحرم: غير مؤكدة — لا تذكر أي رقم، قول إن الفريق هيأكد المسافة';
        return `[تعليمة: العميل سأل بالاسم عن فندق "${hotel.name ?? ''}" — ارد بهذه المعلومات مباشرة بدون أسئلة متابعة]
فندق: ${hotel.name ?? ''}${starsStr}
الموقع: ${location}
${distanceLine}
أبرز ميزة: ${highlight}${ratingStr}
رابط الحجز: ${link}`;
      }
    }
  }
  return null;
}


export function buildHotelKnowledgeFromData(hotels: HotelEntry[]): string {
  const mecca  = hotels.filter(h => !h.location?.includes('المدينة المنورة'))
  const medina = hotels.filter(h =>  h.location?.includes('المدينة المنورة') ?? false)

  function renderHotel(h: HotelEntry): string {
    const header    = h.stars    ? `${h.name ?? ''} (${h.stars}):` : `${h.name ?? ''}:`
    const distance  = h.distance ?? ''
    const link      = h.link     ?? (h as any).bookingLink ?? ''
    const lines: string[] = [header]
    if (distance) lines.push(`- المسافة: ${distance}`)
    if (h.highlight) lines.push(`- آراء العملاء: ${h.highlight}`)
    if (h.rating)    lines.push(`- تقييم: ${h.rating}`)
    if (link)        lines.push(`- رابط الحجز: ${link}`)
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
