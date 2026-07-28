/**
 * dynamic-catalog-builder.ts
 *
 * Reads CompanyAIConfig from the DB and renders the same Arabic markdown prompt
 * sections that the static .ts files produce.  The AI sees IDENTICAL output
 * regardless of which path (static or DB) is active.
 *
 * Call buildIndustryPromptFromDB(config, companyName) where config is the
 * CompanyAIConfig record already fetched from Prisma.
 */

import { CompanyAIConfig } from '@prisma/client'
import { toArabicIndic, formatPrice } from '../../utils/arabic-numerals'
import { UmrahProgram, ProgramType, buildUmrahCatalogTableFromData } from './umrah-packages-2026'
import { HotelEntry, buildHotelKnowledgeFromData, findHotelInMessageFromData } from './hajj-umrah-hotels'

// ── Offerings bridge — semantic role → raw field value ────────────────────────

export interface FieldDef {
  key: string
  label: string
  role: string | null
  inputType: string
  required: boolean
  showInList: boolean
}

/** Returns the value for the first field whose role matches, or null. */
export function extractByRole(
  values: Record<string, unknown>,
  fieldDefs: FieldDef[],
  role: string,
): unknown {
  const def = fieldDefs.find(f => f.role === role)
  if (!def) return null
  return values[def.key] ?? null
}

/**
 * Maps one Offering's values + its type's fieldDefs to the same raw shape as
 * catalog.umrahPrograms entries.  All downstream builders already accept this
 * shape — normDbUmrahProgram and the any[] readers both use the field names
 * produced here (makkahHotel, quadPrice, etc.).
 */
export function offeringToRawUmrahProgram(
  values: Record<string, unknown>,
  fieldDefs: FieldDef[],
): Record<string, unknown> {
  const makkahNights  = (values['makkahNights']  as number) ?? 0
  const madinahNights = (values['madinahNights'] as number) ?? 0
  return {
    id:               values['id']               ?? '',
    name:             extractByRole(values, fieldDefs, 'title'),
    departureDate:    extractByRole(values, fieldDefs, 'start-date'),
    returnDate:       extractByRole(values, fieldDefs, 'end-date'),
    makkahHotel:      extractByRole(values, fieldDefs, 'location'),
    madinahHotel:     extractByRole(values, fieldDefs, 'location-2'),
    quadPrice:        extractByRole(values, fieldDefs, 'price'),
    triplePrice:      extractByRole(values, fieldDefs, 'price-triple'),
    doublePrice:      extractByRole(values, fieldDefs, 'price-double'),
    makkahNights,
    madinahNights,
    nights:           makkahNights + madinahNights,
    makkahBreakfast:  values['makkahBreakfast']  ?? false,
    madinahBreakfast: values['madinahBreakfast'] ?? false,
    haramainTrain:    values['haramainTrain']    ?? false,
    airline:          values['airline']          ?? '',
    route:            values['route']            ?? '',
  }
}

// ── JSON shape definitions (mirrors the migration script + agent data) ────────

interface HajjProgramSection {
  dateHijri: string
  dateGregorian: string
  hotel: string
  roomType?: string
  meals: string
  note?: string
  durationDays?: number
}

interface HajjProgram {
  id: string
  name: string
  pricePerPerson: number | null
  discountedPrice?: number
  discountAmount?: number
  discountNote?: string
  transportationType: string
  haramainTrain: boolean
  haramainTrainClass?: string
  includesAirTicket: boolean
  ticketType: string
  subLevels?: string
  medina?: HajjProgramSection
  transitToMecca?: string
  aziziyah?: HajjProgramSection
  makkahPreSeason?: HajjProgramSection
  arafat?: string | null
  mina?: string | null
  manasikhMeals?: string
  tahseen?: HajjProgramSection | null
  highlights: string[]
  scholarNote?: string | null
}

interface CatalogJson {
  umrahPrograms: UmrahProgram[]
  hajjPrograms: HajjProgram[]
  hotelBookingLinks: Record<string, string>
}

interface IndustryDataJson {
  branches: Array<{ city: string; address: string; note?: string }>
  companyDescription: string
  hotels: HotelEntry[]
  hajjHijriDates: Array<{ hijri: string; gregorian: string }>
  installmentContact: { city: string; agentName: string; phone: string }
}

// ── Normalise DB umrah program records → UmrahProgram ─────────────────────────
// DB programs (from the migration script) use different field names than the
// UmrahProgram interface.  This mapper bridges the gap so the renderer always
// receives correctly-shaped objects regardless of which schema was used.
function normDbUmrahProgram(p: any, idx: number): UmrahProgram {
  const MONTH_NAMES: Record<number, string> = { 7: 'يوليو', 8: 'أغسطس', 9: 'سبتمبر' }

  // Convert ISO date → Arabic display, e.g. '2026-07-26' → '٢٦ يوليو ٢٠٢٦'
  const isoToArabic = (iso: string): string => {
    if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso ?? ''
    const day = parseInt(iso.slice(8), 10)
    const mon = parseInt(iso.slice(5, 7), 10)
    return `${toArabicIndic(day)} ${MONTH_NAMES[mon] ?? iso.slice(5, 7)} ٢٠٢٦`
  }

  const isoDepart: string = p.departureDate ?? ''
  const monthNum = parseInt(isoDepart.slice(5, 7), 10)
  const month = MONTH_NAMES[monthNum] ?? 'يوليو'

  // Derive programType from Arabic name field
  const name: string = p.name ?? ''
  let programType: ProgramType = 'اقتصادي متميز'
  if (name.includes('خمس نجوم') || name.includes('فاخر')) programType = 'خمس نجوم'
  else if (name.includes('اقتصادي متميز')) programType = 'اقتصادي متميز'
  else if (name.includes('اقتصادي')) programType = 'اقتصادي'

  // Extract tripNumber / programNumber from id  e.g. 'trip1a-...' or 'trip10c-...'
  const idMatch = (p.id ?? '').match(/^trip(\d+)([a-e])/i)
  const tripNumber = idMatch ? parseInt(idMatch[1], 10) : idx + 1
  const letterMap: Record<string, number> = { a: 1, b: 2, c: 3, d: 4, e: 5 }
  const programNumber = idMatch ? (letterMap[idMatch[2].toLowerCase()] ?? 1) : 1

  const nights: number = p.nights ?? 0

  return {
    tripNumber,
    programNumber,
    duration: nights + 1,
    nights,
    departureDate:    isoDepart.includes('-') ? isoToArabic(isoDepart) : (isoDepart || ''),
    returnDate:       (p.returnDate ?? '').includes('-') ? isoToArabic(p.returnDate) : (p.returnDate ?? ''),
    departureDateISO: isoDepart,
    returnDateISO:    p.returnDate ?? '',
    departureDateHijri: p.departureDateHijri ?? '',  // empty → fmtHijriRange returns ''
    returnDateHijri:    p.returnDateHijri    ?? '',
    month,
    haramainTrain:    p.haramainTrain    ?? false,
    meccaNights:      p.makkahNights     ?? p.meccaNights      ?? 0,
    medinaNights:     p.madinahNights    ?? p.medinaNights     ?? 0,
    medinaHotel:      p.madinahHotel     ?? p.medinaHotel      ?? '',
    medinaBreakfast:  p.madinahBreakfast ?? p.medinaBreakfast  ?? false,
    meccaHotel:       p.makkahHotel      ?? p.meccaHotel       ?? '',
    meccaBreakfast:   p.makkahBreakfast  ?? p.meccaBreakfast   ?? false,
    priceQuad:        p.quadPrice        ?? p.priceQuad        ?? 0,
    priceTriple:      p.triplePrice      ?? p.priceTriple      ?? 0,
    priceDouble:      p.doublePrice      ?? p.priceDouble      ?? 0,
    programType,
  }
}

// ── Identity block ────────────────────────────────────────────────────────────

function buildIdentityFromDB(
  companyName: string,
  industryData: IndustryDataJson,
): string {
  const branchLines = industryData.branches
    .map(b => `${b.city}: ${b.address}${b.note ? ` (${b.note})` : ''}`)
    .join('\n')

  return `## القسم ١ — من أنت
أنت مستشار حجز عمرة محترف تعمل لصالح "${companyName}" — ${industryData.companyDescription}

أنت موظف مبيعات محترف وموثوق بيتكلم مع حضرات العملاء بأسلوب راقي ودافئ وعنده خبرة كبيرة في رحلات العمرة — ليس لديك اسم شخصي في المحادثة ولا تعرّف بنفسك بأي اسم

## فروع الشركة
${branchLines}

## تعليمة الفروع
لو العميل سأل عن أقرب فرع أو عن عنوان فرع معين أو عايز يحجز حضورياً اعرض عليه عنوان الفرع المناسب من البيانات أعلاه بالضبط كما هو مكتوب — لا تعدل أو تخلط بين العناوين.

## تعليمة الحج والعمرة
"${companyName}" تقدم برامج العمرة وبرامج الحج معاً — تفاصيل برامج كل منهما موجودة في القسم ٣ أدناه.`
}

// ── Hajj catalog renderer ─────────────────────────────────────────────────────

function renderHajjProgram(p: HajjProgram, globalIndex?: number): string {
  const priceLabel = !p.pricePerPerson
    ? `سعر خاص — للتواصل مع المبيعات`
    : p.discountedPrice
      ? `${formatPrice(p.pricePerPerson)} جنيه للفرد (بدون تذكرة ${p.ticketType}) | بعد الخصم: ${formatPrice(p.discountedPrice)} جنيه (خصم ${formatPrice(p.discountAmount ?? 0)} جنيه، ${p.discountNote ?? ''})`
      : `${formatPrice(p.pricePerPerson)} جنيه للفرد (بدون تذكرة ${p.ticketType})`

  const numPrefix = globalIndex != null ? `${toArabicIndic(globalIndex + 1)}. ` : ''
  const lines: string[] = [`${numPrefix}*${p.name}* — ${priceLabel}`]

  if (p.scholarNote) lines.push(p.scholarNote)
  if (p.subLevels)   lines.push(`مدة البرنامج: ${p.subLevels}`)

  if (p.medina) {
    const rm = p.medina.roomType ? ` | ${p.medina.roomType}` : ''
    lines.push(`المدينة: ${p.medina.dateHijri} (الموافق ${p.medina.dateGregorian}) | فندق ${p.medina.hotel}${rm} | ${p.medina.meals}`)
  }

  if (p.transitToMecca) lines.push(p.transitToMecca)

  if (p.aziziyah) {
    const noteStr = p.aziziyah.note ? ` (${p.aziziyah.note})` : ''
    const rm = p.aziziyah.roomType ? ` | ${p.aziziyah.roomType}` : ''
    lines.push(`العزيزية: ${p.aziziyah.dateHijri} (الموافق ${p.aziziyah.dateGregorian})${noteStr} | فندق ${p.aziziyah.hotel}${rm} | ${p.aziziyah.meals}`)
  }

  if (p.makkahPreSeason) {
    lines.push(`مكة: ${p.makkahPreSeason.dateHijri} (الموافق ${p.makkahPreSeason.dateGregorian}) | فندق ${p.makkahPreSeason.hotel} | ${p.makkahPreSeason.meals}`)
  }

  if (p.arafat)         lines.push(`عرفات: ${p.arafat}`)
  if (p.mina)           lines.push(`منى: ${p.mina}`)
  if (p.manasikhMeals)  lines.push(p.manasikhMeals)

  if (p.tahseen) {
    const durStr = p.tahseen.durationDays ? ` (${p.tahseen.durationDays} أيام كاملة)` : ''
    lines.push(`التحسين: ${p.tahseen.dateHijri} (الموافق ${p.tahseen.dateGregorian}) | فندق ${p.tahseen.hotel}${durStr} | ${p.tahseen.meals}`)
  }

  if (p.highlights.length > 0) {
    p.highlights.forEach(h => lines.push(`· ${h}`))
  }

  return lines.join('\n')
}

function buildHajjCatalogFromDB(
  hajjPrograms: HajjProgram[],
  hijriDates: Array<{ hijri: string; gregorian: string }>,
): string {
  const hijriTable = hijriDates
    .map(d => `• ${d.hijri} تقريباً = ${d.gregorian}`)
    .join('\n')

  const programBlocks = hajjPrograms.map(p => renderHajjProgram(p)).join('\n\n')

  return `## القسم ٣ب — برامج الحج ١٤٤٨هـ (مايو ٢٠٢٧م) (الأسعار للفرد الواحد - بدون تذكرة الطيران أو العبّارة)
⚠️ تنبيه إلزامي: كل سعر حج مذكور هنا هو للفرد الواحد فقط وبدون تذكرة الطيران أو العبّارة — يجب ذكر هذا التوضيح دائماً عند عرض أي سعر.

جدول تحويل تواريخ ذي الحجة ١٤٤٨هـ (تقديرية — يُعلن الرسمي بعد رؤية الهلال):
${hijriTable}

${programBlocks}

## تعليمات بيع برامج الحج
• الأسعار أعلاه كلها للفرد الواحد وكلها بدون تذكرة الطيران أو العبّارة — هذا التوضيح إلزامي مع كل سعر تذكره
• لو العميل طلب تفاصيل كل البرامج (كل البرامج بالتفاصيل / اعرضهم كلهم بالتفصيل / تفاصيل كل حاجة): اعرض كل برنامج بتفاصيله الكاملة من الكتالوج بالترتيب — برنامج مستقل في رسالة واحدة
• لو العميل طلب تفاصيل برنامج بعينه أو سأل عن ميزانية محددة: اعرض التفاصيل الكاملة لما يناسبه فقط
• لحساب الإجمالي: السعر للفرد × عدد الأفراد، واذكر دائماً "وده بدون تذكرة الطيران/العبّارة"
• لو سأل "هل يشمل الطيران؟" — جاوب بوضوح: "لا يافندم السعر ده بدون تذكرة الطيران/العبّارة، التذكرة بتُحسب بشكل منفصل حسب توفرها وقت الحجز"`
}

// Returns one fully-rendered string per program (used for code-driven chunked delivery)
export function buildHajjProgramDetailsArray(hajjPrograms: HajjProgram[]): string[] {
  return hajjPrograms.map((p, i) => renderHajjProgram(p, i))
}

// ── Deterministic Hajj overview message — AI never touches this ───────────────

export interface HajjOverviewResult {
  message: string
  orderedDetails: string[]  // renderHajjProgram output in overview order (index 0 = program ١)
}

export function buildHajjOverviewMessage(hajjPrograms: HajjProgram[]): HajjOverviewResult {
  const is5Star = (p: HajjProgram) =>
    p.name.startsWith('برنامج ٥ نجوم') || p.name.startsWith('٥ نجوم') || p.name.includes('خمس نجوم')
  const isKadan = (p: HajjProgram) => p.name.includes('كدانة')
  const hasPrice = (p: HajjProgram) => !!p.pricePerPerson   // 0 and null both falsy

  const sortByPrice = (a: HajjProgram, b: HajjProgram) =>
    (a.pricePerPerson ?? 0) - (b.pricePerPerson ?? 0)

  const economic = hajjPrograms.filter(p => hasPrice(p) && !is5Star(p) && !isKadan(p)).sort(sortByPrice)
  const fiveStar = hajjPrograms.filter(p => hasPrice(p) && is5Star(p)).sort(sortByPrice)
  const kadan    = hajjPrograms.filter(p => hasPrice(p) && isKadan(p)).sort(sortByPrice)
  const special  = hajjPrograms.filter(p => !hasPrice(p))

  if (economic.length + fiveStar.length + kadan.length + special.length === 0) {
    return { message: '', orderedDetails: [] }
  }

  const ordered = [...economic, ...fiveStar, ...kadan, ...special]
  const orderedDetails = ordered.map((p, i) => renderHajjProgram(p, i))

  let n = 0
  const ovLine = (p: HajjProgram): string => {
    n++
    const num = toArabicIndic(n)
    const name = p.name.trim()
    if (!p.pricePerPerson) return `${num}• *${name}*`
    const price = formatPrice(p.pricePerPerson)
    // Show ticket note only when it's not the standard airplane ticket
    const ticketNote = p.ticketType && p.ticketType !== 'طيران'
      ? ` (بدون تذكرة ال${p.ticketType.replace(/^ال/, '')})` : ''
    if (p.discountedPrice) {
      return `${num}• *${name}* — ${price} جنيه/فرد وبعد الخصم ${formatPrice(p.discountedPrice)} جنيه/فرد`
    }
    return `${num}• *${name}* — ${price} جنيه/فرد${ticketNote}`
  }

  const lines: string[] = [`*برامج الحج ١٤٤٨هـ — مايو ٢٠٢٧م*`]

  if (economic.length > 0) {
    lines.push('')
    lines.push('*البرامج الاقتصادية:*')
    economic.forEach(p => lines.push(ovLine(p)))
  }
  if (fiveStar.length > 0) {
    lines.push('')
    lines.push('*الخمس نجوم:*')
    fiveStar.forEach(p => lines.push(ovLine(p)))
  }
  if (kadan.length > 0) {
    lines.push('')
    lines.push('*أبراج كدانة (أبراج فندقية في منى):*')
    kadan.forEach(p => lines.push(ovLine(p)))
  }
  if (special.length > 0) {
    lines.push('')
    lines.push('*سعر خاص — للتواصل مع المبيعات:*')
    special.forEach(p => lines.push(ovLine(p)))
  }

  lines.push('')
  lines.push('ابعت رقم البرنامج وهبعتلك تفاصيله كاملة')

  return { message: lines.join('\n'), orderedDetails }
}

// ── Category-first Hajj flow ──────────────────────────────────────────────────

export const HAJJ_OV_DISCLAIMER =
  'ملاحظة: التواريخ الهجرية لبرامج الحج ١٤٤٨هـ تقديرية بناءً على الحساب الفلكي وسيُعلن الرسمي منها بعد رؤية الهلال قبل الموسم بأسابيع'

export function buildHajjCategoryQuestion(): string {
  return `*برامج الحج ١٤٤٨هـ — مايو ٢٠٢٧م*

عندنا نوعين من البرامج:
١• *البرامج الاقتصادية* — أفضل الأسعار مع مواصفات متميزة
٢• *برامج خمس نجوم* — أعلى مستوى من الراحة والفخامة

إيه اللي يناسبك يافندم — اقتصادي ولا خمس نجوم؟`
}

function renderHajjProgramValueFirst(p: HajjProgram, num: number): string {
  const lines: string[] = [`⭐ ${toArabicIndic(num)}• *${p.name}*`]

  if (p.scholarNote) lines.push(`· ${p.scholarNote}`)
  if (p.subLevels)   lines.push(`· مدة البرنامج: ${p.subLevels}`)

  if (p.medina) {
    const rm = p.medina.roomType ? ` — ${p.medina.roomType}` : ''
    lines.push(`· المدينة: ${p.medina.dateHijri} (${p.medina.dateGregorian}) — ${p.medina.hotel}${rm} — ${p.medina.meals}`)
  }
  if (p.transitToMecca) lines.push(`· ${p.transitToMecca}`)
  if (p.aziziyah) {
    const noteStr = p.aziziyah.note ? ` (${p.aziziyah.note})` : ''
    const rm = p.aziziyah.roomType ? ` — ${p.aziziyah.roomType}` : ''
    lines.push(`· العزيزية: ${p.aziziyah.dateHijri} (${p.aziziyah.dateGregorian})${noteStr} — ${p.aziziyah.hotel}${rm} — ${p.aziziyah.meals}`)
  }
  if (p.makkahPreSeason) {
    lines.push(`· مكة: ${p.makkahPreSeason.dateHijri} (${p.makkahPreSeason.dateGregorian}) — ${p.makkahPreSeason.hotel} — ${p.makkahPreSeason.meals}`)
  }
  if (p.arafat)        lines.push(`· عرفات: ${p.arafat}`)
  if (p.mina)          lines.push(`· منى: ${p.mina}`)
  if (p.manasikhMeals) lines.push(`· ${p.manasikhMeals}`)
  if (p.tahseen) {
    const durStr = p.tahseen.durationDays ? ` (${p.tahseen.durationDays} أيام كاملة)` : ''
    lines.push(`· التحسين: ${p.tahseen.dateHijri} (${p.tahseen.dateGregorian}) — ${p.tahseen.hotel}${durStr} — ${p.tahseen.meals}`)
  }
  p.highlights.forEach(h => lines.push(`· ${h}`))

  // Price comes last
  if (!p.pricePerPerson) {
    lines.push(`السعر: للتواصل مع المبيعات`)
  } else if (p.discountedPrice) {
    lines.push(`السعر: ${formatPrice(p.pricePerPerson)} جنيه/فرد — وبعد الخصم ${formatPrice(p.discountedPrice)} جنيه/فرد (بدون تذكرة ${p.ticketType})`)
  } else {
    const ticketNote = p.ticketType ? ` (بدون تذكرة ${p.ticketType})` : ''
    lines.push(`السعر: ${formatPrice(p.pricePerPerson)} جنيه/فرد${ticketNote}`)
  }

  return lines.join('\n')
}

export function buildHajjCategoryPrograms(
  category: 'ECONOMY' | 'FIVE_STAR',
  hajjPrograms: HajjProgram[],
  disclaimer: string,
): { message: string; orderedDetails: string[] } {
  const is5Star  = (p: HajjProgram) =>
    p.name.startsWith('برنامج ٥ نجوم') || p.name.startsWith('٥ نجوم') || p.name.includes('خمس نجوم')
  const isKadan  = (p: HajjProgram) => p.name.includes('كدانة')
  const hasPrice = (p: HajjProgram) => !!p.pricePerPerson
  const sortByPrice = (a: HajjProgram, b: HajjProgram) =>
    (a.pricePerPerson ?? 0) - (b.pricePerPerson ?? 0)

  let programs: HajjProgram[]
  let header: string
  if (category === 'FIVE_STAR') {
    programs = hajjPrograms.filter(p => hasPrice(p) && is5Star(p)).sort(sortByPrice)
    header = `*برامج خمس نجوم — الحج ١٤٤٨هـ*`
  } else {
    programs = hajjPrograms.filter(p => hasPrice(p) && !is5Star(p) && !isKadan(p)).sort(sortByPrice)
    header = `*البرامج الاقتصادية — الحج ١٤٤٨هـ*`
  }

  if (programs.length === 0) return { message: '', orderedDetails: [] }

  const orderedDetails = programs.map((p, i) => renderHajjProgram(p, i))

  const lines: string[] = [header]
  programs.forEach((p, i) => {
    lines.push('')
    lines.push(renderHajjProgramValueFirst(p, i + 1))
  })
  lines.push('')
  lines.push('تحب تعرف تفاصيل الحجز؟ ابعت رقم البرنامج وهبعتلك الكل')
  if (category === 'FIVE_STAR') {
    lines.push('وعندنا كمان برامج أبراج كدانة — قوللي لو حابب تفاصيلها')
  }
  lines.push('')
  lines.push(disclaimer)

  return { message: lines.join('\n'), orderedDetails }
}

// ── Deterministic Umrah month overview — one WhatsApp message with hotel info ─

const MONTH_NAME_TO_NUM: Record<string, number> = {
  'يوليو': 7, 'أغسطس': 8, 'سبتمبر': 9, 'أكتوبر': 10, 'نوفمبر': 11,
}

function umrahProgramLevel(p: any): string {
  const name: string = p.name ?? ''
  if (name.includes('خمس نجوم') || name.includes('فاخر')) return 'خمس نجوم'
  if (name.includes('اقتصادي متميز')) return 'اقتصادي متميز'
  if (name.includes('اقتصادي')) return 'اقتصادي'
  return name || 'اقتصادي'
}

const UMRAH_LEVEL_ORDER = ['اقتصادي', 'اقتصادي متميز', 'خمس نجوم']

function umrahTripLevels(progs: any[]): string[] {
  const seen = new Set(progs.map(umrahProgramLevel))
  const ordered = UMRAH_LEVEL_ORDER.filter(l => seen.has(l))
  for (const l of seen) { if (!UMRAH_LEVEL_ORDER.includes(l)) ordered.push(l) }
  return ordered
}

function renderUmrahTripCard(
  n: number,
  depISO: string, retISO: string, duration: number,
  meccaHotel: string, medinaHotel: string,
  levels: string[], minQuad: number,
  levelPrices?: Record<string, number>,
): string {
  const dur = `${toArabicIndic(duration)} ${ovDurWord(duration)}`
  const header = `⭐ ${toArabicIndic(n)}• ${ovFmtDay(depISO)} — ${ovFmtDay(retISO)} (${dur})`
  if (levelPrices && levels.length > 1) {
    const priceLine = levels.map(l => `${l}: من ${formatPrice(levelPrices[l] ?? 0)}`).join(' | ')
    return [header, `· ${priceLine}`, `· ابعت رقم الرحلة لتفاصيل الفنادق والأسعار`].join('\n')
  }
  const hotelParts: string[] = []
  if (meccaHotel)  hotelParts.push(`مكة: ${meccaHotel}`)
  if (medinaHotel) hotelParts.push(`المدينة: ${medinaHotel}`)
  return [
    header,
    `· ${hotelParts.join(' | ')}`,
    `· المستويات المتاحة: ${levels.join(' / ')}`,
    `· يبدأ من ${formatPrice(minQuad)} جنيه/فرد`,
  ].join('\n')
}

export function buildUmrahMonthMessage(month: string, rawPrograms: any[], level?: string): { message: string; orderedDetails: string[] } {
  const targetMon = MONTH_NAME_TO_NUM[month]
  if (!targetMon) return { message: '', orderedDetails: [] }

  const groups = new Map<string, any[]>()
  for (const p of rawPrograms) {
    const dep = p.departureDate ?? ''
    const ret = p.returnDate ?? ''
    if (!dep || !ret || !/^\d{4}-\d{2}-\d{2}$/.test(dep)) continue
    if (parseInt(dep.slice(5, 7), 10) !== targetMon) continue
    const key = `${dep}|${ret}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(p)
  }

  type TripRow = {
    depISO: string; retISO: string; duration: number
    meccaHotel: string; medinaHotel: string; minQuad: number
    levels: string[]; progs: any[]
  }
  const trips: TripRow[] = []
  for (const [key, progs] of groups) {
    const [depISO, retISO] = key.split('|')
    const depMs = new Date(depISO + 'T00:00:00Z').getTime()
    const retMs = new Date(retISO + 'T00:00:00Z').getTime()
    const duration = Math.round((retMs - depMs) / 86400000) + 1
    const quadPrices = progs.map((p: any) => p.quadPrice ?? p.priceQuad ?? 0).filter((x: number) => x > 0)
    if (quadPrices.length === 0) continue
    const minQuad = Math.min(...quadPrices)
    const minProg = progs.find((p: any) => (p.quadPrice ?? p.priceQuad ?? 0) === minQuad) ?? progs[0]
    const meccaHotel  = minProg.makkahHotel  ?? minProg.meccaHotel  ?? ''
    const medinaHotel = minProg.madinahHotel ?? minProg.medinaHotel ?? ''
    trips.push({ depISO, retISO, duration, meccaHotel, medinaHotel, minQuad, levels: umrahTripLevels(progs), progs })
  }
  trips.sort((a, b) => a.depISO.localeCompare(b.depISO))

  if (trips.length === 0) return { message: '', orderedDetails: [] }

  // orderedDetails always covers ALL trips so global trip numbers resolve correctly via overviewMap
  const orderedDetails = trips.map(t => renderUmrahTripDetail(t.depISO, t.retISO, t.duration, t.progs))

  // Build per-card display info — level filter narrows cards but preserves global trip numbers
  type CardInfo = {
    globalN: number; depISO: string; retISO: string; duration: number
    mecca: string; medina: string; displayLevels: string[]; minQuad: number
    levelPrices?: Record<string, number>
  }
  const cards: CardInfo[] = []
  trips.forEach((t, i) => {
    const globalN = i + 1
    if (level) {
      const levelProgs = t.progs.filter(p => umrahProgramLevel(p) === level)
      if (levelProgs.length === 0) return
      const lvlPrices = levelProgs.map((p: any) => p.quadPrice ?? p.priceQuad ?? 0).filter((x: number) => x > 0)
      if (lvlPrices.length === 0) return
      const lvlMin  = Math.min(...lvlPrices)
      const lvlProg = levelProgs.find((p: any) => (p.quadPrice ?? p.priceQuad ?? 0) === lvlMin) ?? levelProgs[0]
      cards.push({
        globalN, depISO: t.depISO, retISO: t.retISO, duration: t.duration,
        mecca:  lvlProg.makkahHotel  ?? lvlProg.meccaHotel  ?? '',
        medina: lvlProg.madinahHotel ?? lvlProg.medinaHotel ?? '',
        displayLevels: [level],
        minQuad: lvlMin,
      })
    } else {
      let levelPrices: Record<string, number> | undefined
      if (t.levels.length > 1) {
        levelPrices = {}
        for (const lvl of t.levels) {
          const lvlPrices = t.progs
            .filter((p: any) => umrahProgramLevel(p) === lvl)
            .map((p: any) => p.quadPrice ?? p.priceQuad ?? 0)
            .filter((x: number) => x > 0)
          if (lvlPrices.length > 0) levelPrices[lvl] = Math.min(...lvlPrices)
        }
      }
      cards.push({
        globalN, depISO: t.depISO, retISO: t.retISO, duration: t.duration,
        mecca: t.meccaHotel, medina: t.medinaHotel, displayLevels: t.levels, minQuad: t.minQuad,
        levelPrices,
      })
    }
  })

  if (level && cards.length === 0) return { message: '', orderedDetails: [] }

  const title = level ? `*رحلات عمرة ${month} ٢٠٢٦ — ${level}*` : `*رحلات عمرة ${month} ٢٠٢٦*`
  const parts: string[] = [title]
  cards.forEach(c => {
    parts.push(renderUmrahTripCard(c.globalN, c.depISO, c.retISO, c.duration, c.mecca, c.medina, c.displayLevels, c.minQuad, c.levelPrices))
  })
  parts.push('ابعت رقم الرحلة اللي تناسبك وهبعتلك مستوياتها وأسعارها كاملة')

  return { message: parts.join('\n\n'), orderedDetails }
}

// ── Umrah month overview — code-built for verbatim copy (no AI price hallucination) ──

const OV_MONTHS: Record<number, string> = { 7: 'يوليو', 8: 'أغسطس', 9: 'سبتمبر', 10: 'أكتوبر', 11: 'نوفمبر' }

function ovFmtDay(iso: string): string {
  const day = parseInt(iso.slice(8), 10)
  const mon = parseInt(iso.slice(5, 7), 10)
  return `${toArabicIndic(day)} ${OV_MONTHS[mon] ?? iso.slice(5, 7)}`
}

function ovDurWord(n: number): string { return n >= 3 && n <= 10 ? 'أيام' : 'يوم' }

function renderUmrahTripDetail(depISO: string, retISO: string, duration: number, progs: any[]): string {
  const header = `*رحلة ${ovFmtDay(depISO)} — ${ovFmtDay(retISO)} ٢٠٢٦ (${toArabicIndic(duration)} ${ovDurWord(duration)})*`
  const sorted = [...progs].sort((a, b) => (a.quadPrice ?? a.priceQuad ?? 0) - (b.quadPrice ?? b.priceQuad ?? 0))
  const lines: string[] = [header, '']
  for (const p of sorted) {
    const meccaHotel  = p.makkahHotel  ?? p.meccaHotel  ?? ''
    const medinaHotel = p.madinahHotel ?? p.medinaHotel ?? ''
    const meccaBf     = p.makkahBreakfast  ?? p.meccaBreakfast  ?? false
    const medinaBf    = p.madinahBreakfast ?? p.medinaBreakfast ?? false
    const quad   = p.quadPrice   ?? p.priceQuad   ?? 0
    const triple = p.triplePrice ?? p.priceTriple ?? 0
    const double = p.doublePrice ?? p.priceDouble ?? 0
    const name: string = p.name ?? ''
    let typeLabel: string
    if (name.includes('خمس نجوم') || name.includes('فاخر')) typeLabel = 'خمس نجوم'
    else if (name.includes('اقتصادي متميز')) typeLabel = 'اقتصادي متميز'
    else if (name.includes('اقتصادي')) typeLabel = 'اقتصادي'
    else typeLabel = name || 'اقتصادي'
    const meccaStr  = meccaHotel  ? `مكة: ${meccaHotel}${meccaBf  ? ' (إفطار)' : ''}` : ''
    const medinaStr = medinaHotel ? `المدينة: ${medinaHotel}${medinaBf ? ' (إفطار)' : ''}` : ''
    const hotelsStr = [meccaStr, medinaStr].filter(Boolean).join(' | ')
    lines.push(`• ${typeLabel}${hotelsStr ? ' — ' + hotelsStr : ''}`)
    lines.push(`رباعي: ${formatPrice(quad)} ج/فرد | ثلاثي: ${formatPrice(triple)} ج/فرد | ثنائي: ${formatPrice(double)} ج/فرد`)
    lines.push('')
  }
  if (lines[lines.length - 1] === '') lines.pop()
  return lines.join('\n')
}

export function buildUmrahMonthOverview(rawPrograms: any[]): string {
  const groups = new Map<string, any[]>()
  for (const p of rawPrograms) {
    const dep = p.departureDate ?? ''
    const ret = p.returnDate ?? ''
    if (!dep || !ret || !/^\d{4}-\d{2}-\d{2}$/.test(dep)) continue
    const key = `${dep}|${ret}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(p)
  }

  type Trip = { depISO: string; retISO: string; depMonth: number; duration: number; minPrice: number }
  const trips: Trip[] = []

  for (const [key, progs] of groups) {
    const [depISO, retISO] = key.split('|')
    const depMs = new Date(depISO + 'T00:00:00Z').getTime()
    const retMs = new Date(retISO + 'T00:00:00Z').getTime()
    const duration = Math.round((retMs - depMs) / 86400000) + 1
    const depMonth = parseInt(depISO.slice(5, 7), 10)
    const prices = progs.map((p: any) => p.quadPrice ?? p.priceQuad ?? 0).filter((x: number) => x > 0)
    if (prices.length === 0) continue
    trips.push({ depISO, retISO, depMonth, duration, minPrice: Math.min(...prices) })
  }

  trips.sort((a, b) => a.depISO.localeCompare(b.depISO))

  const months = [7, 8, 9, 10, 11]
  const blocks: string[] = []
  for (const mon of months) {
    const mt = trips.filter(t => t.depMonth === mon)
    if (mt.length === 0) continue
    const monName = OV_MONTHS[mon] ?? String(mon)
    const lines = mt.map(t =>
      `${ovFmtDay(t.depISO)} — ${ovFmtDay(t.retISO)} (${toArabicIndic(t.duration)} ${ovDurWord(t.duration)}) — يبدأ من ${formatPrice(t.minPrice)} جنيه للفرد`
    )
    blocks.push(`[ملخص رحلات ${monName} ٢٠٢٦ — انقله حرفياً]\n${lines.join('\n')}\n[/ملخص رحلات ${monName} ٢٠٢٦]`)
  }

  if (blocks.length === 0) return ''
  return `## ملخص رحلات العمرة بالشهر (جاهز — انقل سطور كل شهر حرفياً بدون تعديل)\n${blocks.join('\n\n')}`
}

// ── All-months umrah overview — numbered globally across months, for general queries ──

export function buildUmrahAllMonthsOverview(rawPrograms: any[]): { message: string; orderedDetails: string[] } {
  const MONTH_ORDER = ['يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر']
  const MONTH_NUM: Record<string, number> = { 'يوليو': 7, 'أغسطس': 8, 'سبتمبر': 9, 'أكتوبر': 10, 'نوفمبر': 11 }

  type TripEntry = {
    depISO: string; retISO: string; duration: number
    meccaHotel: string; medinaHotel: string; minQuad: number
    levels: string[]; progs: any[]; month: string
  }

  const allTrips: TripEntry[] = []

  for (const month of MONTH_ORDER) {
    const targetMon = MONTH_NUM[month]
    const groups = new Map<string, any[]>()
    for (const p of rawPrograms) {
      const dep = p.departureDate ?? ''
      const ret = p.returnDate ?? ''
      if (!dep || !ret || !/^\d{4}-\d{2}-\d{2}$/.test(dep)) continue
      if (parseInt(dep.slice(5, 7), 10) !== targetMon) continue
      const key = `${dep}|${ret}`
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(p)
    }
    const monthTrips: TripEntry[] = []
    for (const [key, progs] of groups) {
      const [depISO, retISO] = key.split('|')
      const depMs = new Date(depISO + 'T00:00:00Z').getTime()
      const retMs = new Date(retISO + 'T00:00:00Z').getTime()
      const duration = Math.round((retMs - depMs) / 86400000) + 1
      const quadPrices = progs.map((p: any) => p.quadPrice ?? p.priceQuad ?? 0).filter((x: number) => x > 0)
      if (quadPrices.length === 0) continue
      const minQuad = Math.min(...quadPrices)
      const minProg = progs.find((p: any) => (p.quadPrice ?? p.priceQuad ?? 0) === minQuad) ?? progs[0]
      const meccaHotel  = minProg.makkahHotel  ?? minProg.meccaHotel  ?? ''
      const medinaHotel = minProg.madinahHotel ?? minProg.medinaHotel ?? ''
      monthTrips.push({ depISO, retISO, duration, meccaHotel, medinaHotel, minQuad, levels: umrahTripLevels(progs), progs, month })
    }
    monthTrips.sort((a, b) => a.depISO.localeCompare(b.depISO))
    allTrips.push(...monthTrips)
  }

  if (allTrips.length === 0) return { message: '', orderedDetails: [] }

  const orderedDetails = allTrips.map(t => renderUmrahTripDetail(t.depISO, t.retISO, t.duration, t.progs))

  // Option A: month header as its own \n\n-separated segment → becomes its own WhatsApp message
  const parts: string[] = ['*برامج العمرة ٢٠٢٦*']
  let currentMonth = ''
  let n = 0
  for (const t of allTrips) {
    if (t.month !== currentMonth) {
      currentMonth = t.month
      parts.push(`*${t.month}:*`)
    }
    n++
    let tripLevelPrices: Record<string, number> | undefined
    if (t.levels.length > 1) {
      tripLevelPrices = {}
      for (const lvl of t.levels) {
        const lvlPrices = t.progs
          .filter((p: any) => umrahProgramLevel(p) === lvl)
          .map((p: any) => p.quadPrice ?? p.priceQuad ?? 0)
          .filter((x: number) => x > 0)
        if (lvlPrices.length > 0) tripLevelPrices[lvl] = Math.min(...lvlPrices)
      }
    }
    parts.push(renderUmrahTripCard(n, t.depISO, t.retISO, t.duration, t.meccaHotel, t.medinaHotel, t.levels, t.minQuad, tripLevelPrices))
  }
  parts.push('ابعت رقم الرحلة اللي تناسبك وهبعتلك مستوياتها وأسعارها كاملة')

  return { message: parts.join('\n\n'), orderedDetails }
}

// ── General knowledge + FAQ — pre-stored in industryData or fallback static ──

const HAJJ_GENERAL_KNOWLEDGE_STATIC = `## القسم ٣ج — معلومات عامة عن رحلة الحج (للإجابة على أسئلة العملاء)

مناسك الحج بالترتيب:
• الإحرام من الميقات
• الطواف والسعي (لمن يؤدي عمرة التمتع أولاً)
• يوم ٨ ذي الحجة: التوجه إلى منى (يوم التروية)
• يوم ٩ ذي الحجة: الوقوف بعرفة — أهم ركن في الحج — من الظهر حتى المغرب
• المبيت بمزدلفة ليلة ٩-١٠ ذي الحجة
• يوم ١٠ ذي الحجة (يوم العيد): رمي جمرة العقبة ثم الهدي/الأضحية ثم الحلق أو التقصير ثم طواف الإفاضة
• أيام التشريق (١١ و١٢ و١٣ ذي الحجة): المبيت بمنى ورمي الجمرات الثلاث كل يوم
• طواف الوداع قبل مغادرة مكة

أنواع النسك:
• التمتع: عمرة ثم تحلل ثم إحرام جديد للحج — الأكثر شيوعاً للمصريين
• القِران: عمرة وحج بنية واحدة بدون تحلل بينهما
• الإفراد: حج فقط بدون عمرة

الفرق بين الحج والعمرة:
• العمرة: ممكن في أي وقت من السنة — مناسكها أبسط (طواف وسعي وحلق فقط)
• الحج: مرة واحدة في السنة فقط في أيام محددة من ذي الحجة — مناسك أكثر والوقوف بعرفة ركن أساسي لا يصح الحج بدونه

أسئلة شائعة:
• "هل يشمل البرنامج الهدي؟" — الهدي ممكن يكون مشمول حسب البرنامج لو مش متأكد من التفاصيل قل: "هتأكد لك التفاصيل مع فريقنا المختص يافندم"
• "هل لازم محرم للمرأة؟" — نعم يلزم محرم أو ترخيص رسمي حسب لوائح وزارة الحج السعودية للمرأة التي تسافر بمفردها
• "هل يشمل التأمين الصحي؟" — التأمين الصحي إلزامي ضمن إجراءات التأشيرة السعودية اسأل فريقنا للتفاصيل الدقيقة
• "متى الموعد النهائي للتسجيل؟" — "التسجيل بيقفل حسب الكوتة المتاحة من وزارة الحج الأفضل التسجيل بدري يافندم"
• "هل السعر شامل التأشيرة؟" — وضح حسب ما هو معروف لو غير مؤكد وجّه للفريق المختص

تنبيه للأسئلة الدينية الدقيقة:
لو سأل العميل سؤالاً فقهياً تفصيلياً في حالة خاصة ليس في معلوماتك — قل بأدب: "في تفاصيل دقيقة زي دي يافندم الأفضل الرجوع لدار الإفتاء أو أحد المرشدين الدينيين المعتمدين معنا أثناء الرحلة وهنكون موجودين لمساعدتك"`

const HAJJ_FAQ_STATIC = `## القسم ٣د — أسئلة شائعة واعتراضات العملاء (الحج)
استخدم هذه المعلومات بشكل طبيعي في المحادثة — لا تقرأها حرفياً — استخدم نفس الحقائق بأسلوبك المعتاد كمستشار متخصص.

س: هل تنصح بغرفة ثنائية في العزيزية للزوجين؟
ج: النصيحة الأمانة إن الغرفة الثنائية في العزيزية مش تستاهل يافندم لأن الإقامة هناك يومين بس. الأحسن تاخد الثنائي في فنادق مكة والمدينة وتاخد رباعي أو ثلاثي في العزيزية — فرق السعر بين الثنائي والرباعي في العزيزية ما بين ٥٠ لـ ٧٠ ألف جنيه مش يستاهل يافندم.

س: الفرق بين المخيمات (بري / اقتصادي / ٥ نجوم)؟
ج: مخيمات البري بتكون بعيدة عن الجمرات والمشي ممكن يوصل ٤.٥ كم. مخيماتنا الاقتصادية وخمس النجوم قريبة من الجمرات. مخيمات منى بشكل عام ضيقة في كل المستويات ما عدا كدانة اللي هي أبراج فندقية مجهزة ومريحة جداً.

س: ليه أحج معاكم؟ / إيه اللي يميزكم؟
ج: عندنا ٤ مزايا رئيسية — أولاً أطول فترة تحسين ٥ نجوم مطلة على الحرم في السوق (من ١٤ لـ ٢٠ ذي الحجة) تستمتع بالحرم براحتك. ثانياً الإقامة في العزيزية يومين بس مش فترة طويلة مجهدة. ثالثاً بنبدأ بالمدينة المنورة للراحة والسكينة قبل المناسك. رابعاً مشايخ ودعاة متخصصون معكم طول الرحلة يشرحون كل خطوة — سافر معنا العام الماضي الدكتور أحمد المنجي والدكتور إبراهيم العانوس وكانوا مع الحجاج خطوة بخطوة.

س: كام تكلفة الأضحية (الصك)؟
ج: الأضحية في السوق بتتراوح من ٥٠٠ لـ ٨٠٠ ريال سعودي. إحنا بنساعدك في شراء الصك وبنجيبه لك وسعره بإذن الله ما هيتجاوزش ٥٠٠ ريال.

س: هل الأكل والوجبات متوفرة؟
ج: آه يافندم كل البرامج شاملة الوجبات — متقلقش من موضوع الأكل طول الرحلة.

س: والدي / والدتي كبار في السن ومش بيقدروا يمشوا؟
ج: إحنا بنعمل دورنا ومش بنبخل في أي جهد يافندم. للأمانة الأفضل يكون معاهم حد من الأقارب كمرافق. وإحنا من جانبنا بنأمن تتبع ذكي GPS لكل حاج عشان نطمن عليه في أي وقت.

س: خايف والدتي تنجح في القرعة وأنا ما أنجحش معاها؟
ج: في التقديم للقرعة بنعمل حاجة اسمها ترابط أسماء — يا إما تنجحوا سوا يا إما لأ قدر الله ما تنجحوش سوا. مفيش حد يسافر لوحده من العيلة بإذن الله.

س: شفت برنامج اقتصادي تحسين عند حد تاني أرخص بـ ٣٠٬٠٠٠ جنيه ليه؟
ج: برامجنا ليها مواصفات ومميزات محددة وضحناها. عشان نقارن صح يفضل تبعتلنا تفاصيل البرنامج التاني عشان نراجعه ونقارن المميزات ونرد عليك بشكل وافٍ — مش كل البرامج بتحمل نفس المواصفات يافندم.`

// ── Batch-1 handler builders ─────────────────────────────────────────────────

// Default CTA template — used when CompanyAIConfig.templates.ctaTemplate is not seeded yet.
const DEFAULT_CTA_TEMPLATE =
  'السلام عليكم ورحمة الله وبركاته 🤍\n' +
  'أهلاً بحضرتك في {{COMPANY_NAME}}\n\n' +
  'ممكن أعرف حضرتك مهتم بالاستفسار عن:\n' +
  '١• برامج العمرة — متاح {{AVAILABLE_MONTHS}}\n' +
  '٢• برامج الحج {{HIJRI_YEAR}}هـ\n' +
  'أم حجز تذاكر طيران؟'

const CTA_MONTH_ORDER = ['يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر']
const CTA_MONTH_NUM: Record<string, number> = { 'يوليو': 7, 'أغسطس': 8, 'سبتمبر': 9, 'أكتوبر': 10, 'نوفمبر': 11 }

export function buildCTAReply(
  template: string,
  companyName: string,
  rawPrograms: any[],
  hijriYear: string,
): string {
  const monthSet = new Set<number>()
  for (const p of rawPrograms) {
    const dep: string = p.departureDate ?? ''
    if (/^\d{4}-\d{2}-\d{2}$/.test(dep)) monthSet.add(parseInt(dep.slice(5, 7), 10))
  }
  const months = CTA_MONTH_ORDER.filter(m => monthSet.has(CTA_MONTH_NUM[m]))
  return template
    .replace(/\{\{COMPANY_NAME\}\}/g, companyName)
    .replace(/\{\{AVAILABLE_MONTHS\}\}/g, months.join(' / '))
    .replace(/\{\{HIJRI_YEAR\}\}/g, hijriYear)
}

// Returns sorted list of distinct trip durations (in days) from the catalog.
export function getAvailableUmrahDurations(rawPrograms: any[]): number[] {
  const seen = new Set<number>()
  for (const p of rawPrograms) {
    const dep: string = p.departureDate ?? ''
    const ret: string = p.returnDate ?? ''
    if (!dep || !ret || !/^\d{4}-\d{2}-\d{2}$/.test(dep)) continue
    const days = Math.round(
      (new Date(ret + 'T00:00:00Z').getTime() - new Date(dep + 'T00:00:00Z').getTime()) / 86400000
    ) + 1
    if (days > 0) seen.add(days)
  }
  return [...seen].sort((a, b) => a - b)
}

export function buildDurationPivotMsg(durations: number[]): string {
  const durWord = (n: number) => (n >= 3 && n <= 10 ? 'أيام' : 'يوم')
  const dStr = durations.map(d => `${toArabicIndic(d)} ${durWord(d)}`).join(' / ')
  return `متاح يافندم برامج ${dStr} — أنهي مدة مناسبة مع حضرتك؟ 🤍`
}

// Filters catalog programs by trip duration and renders a numbered overview + per-trip details.
// Same card renderer as buildUmrahMonthMessage — just filtered by days instead of month.
export function buildUmrahDurationMessage(
  durationDays: number,
  rawPrograms: any[],
): { message: string; orderedDetails: string[] } {
  const groups = new Map<string, any[]>()
  for (const p of rawPrograms) {
    const dep: string = p.departureDate ?? ''
    const ret: string = p.returnDate ?? ''
    if (!dep || !ret || !/^\d{4}-\d{2}-\d{2}$/.test(dep)) continue
    const days = Math.round(
      (new Date(ret + 'T00:00:00Z').getTime() - new Date(dep + 'T00:00:00Z').getTime()) / 86400000
    ) + 1
    if (days !== durationDays) continue
    const key = `${dep}|${ret}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(p)
  }

  type TripRow = {
    depISO: string; retISO: string; duration: number
    meccaHotel: string; medinaHotel: string; minQuad: number
    levels: string[]; progs: any[]
  }
  const trips: TripRow[] = []
  for (const [key, progs] of groups) {
    const [depISO, retISO] = key.split('|')
    const quadPrices = progs.map((p: any) => p.quadPrice ?? p.priceQuad ?? 0).filter((x: number) => x > 0)
    if (quadPrices.length === 0) continue
    const minQuad = Math.min(...quadPrices)
    const minProg = progs.find((p: any) => (p.quadPrice ?? p.priceQuad ?? 0) === minQuad) ?? progs[0]
    trips.push({
      depISO, retISO, duration: durationDays,
      meccaHotel:  minProg.makkahHotel  ?? minProg.meccaHotel  ?? '',
      medinaHotel: minProg.madinahHotel ?? minProg.medinaHotel ?? '',
      minQuad, levels: umrahTripLevels(progs), progs,
    })
  }
  trips.sort((a, b) => a.depISO.localeCompare(b.depISO))
  if (trips.length === 0) return { message: '', orderedDetails: [] }

  const orderedDetails = trips.map(t => renderUmrahTripDetail(t.depISO, t.retISO, t.duration, t.progs))

  const durWord = durationDays >= 3 && durationDays <= 10 ? 'أيام' : 'يوم'
  const title = `*رحلات عمرة ${toArabicIndic(durationDays)} ${durWord}*`
  const parts: string[] = [title]
  trips.forEach((t, i) => {
    let levelPrices: Record<string, number> | undefined
    if (t.levels.length > 1) {
      levelPrices = {}
      for (const lvl of t.levels) {
        const lvlPrices = t.progs
          .filter((p: any) => umrahProgramLevel(p) === lvl)
          .map((p: any) => p.quadPrice ?? p.priceQuad ?? 0)
          .filter((x: number) => x > 0)
        if (lvlPrices.length > 0) levelPrices[lvl] = Math.min(...lvlPrices)
      }
    }
    parts.push(renderUmrahTripCard(i + 1, t.depISO, t.retISO, t.duration, t.meccaHotel, t.medinaHotel, t.levels, t.minQuad, levelPrices))
  })
  parts.push('ابعت رقم الرحلة اللي تناسبك وهبعتلك مستوياتها وأسعارها كاملة 🤍')

  return { message: parts.join('\n\n'), orderedDetails }
}

// ── Main export ───────────────────────────────────────────────────────────────

export interface IndustryPromptParts {
  identity: string
  catalog: string
  hotels: string
  hotelList: HotelEntry[]
  monthOverviews: string
  hajjProgramDetails: string[]
  hajjOverviewMessage: string
  hajjOverviewDetails: string[]
  hajjCategoryQuestion: string
  hajjEconomyPrograms: string
  hajjEconomyDetails: string[]
  hajjFiveStarPrograms: string
  hajjFiveStarDetails: string[]
  umrahMonthMessages: Record<string, string>
  umrahMonthDetails: Record<string, string[]>
  umrahMonthLevelMessages: Record<string, Record<string, string>>
  umrahAllMonthsMessage: string
  umrahAllMonthsDetails: string[]
  // Batch-1 handlers
  ctaReply: string
  installmentReply: string
  umrahDurationMessages: Record<number, string>
  umrahDurationDetails: Record<number, string[]>
  availableDurations: number[]
  durationPivotMsg: string
}

export function buildIndustryPromptFromDB(
  config: CompanyAIConfig,
  companyName: string,
  offeringsOverride?: Array<{ values: Record<string, unknown>; fieldDefs: FieldDef[] }>,
): IndustryPromptParts {
  const cat = config.catalog as unknown as CatalogJson
  const ind = config.industryData as unknown as IndustryDataJson | null

  // Guard: use Offerings table if provided and non-empty; else fall back to catalog.umrahPrograms.
  // A bad Offerings read (empty array) safely falls through to the old path — no company breaks.
  const rawUmrahPrograms: any[] =
    offeringsOverride && offeringsOverride.length > 0
      ? offeringsOverride.map(o => offeringToRawUmrahProgram(o.values, o.fieldDefs))
      : (cat.umrahPrograms as any[])

  // Identity block
  const identity = ind
    ? buildIdentityFromDB(companyName, ind)
    : `## القسم ١ — من أنت\nأنت مستشار حجز عمرة محترف تعمل لصالح "${companyName}"`

  // Umrah catalog table — normalise field names from DB schema → UmrahProgram
  const umrahPrograms = rawUmrahPrograms.map(normDbUmrahProgram)
  const umrahCatalog = buildUmrahCatalogTableFromData(
    umrahPrograms,
    cat.hotelBookingLinks ?? {},
  )

  // Hajj catalog rendered from structured JSON (unchanged — Hajj still reads catalog.hajjPrograms)
  const hajjCatalog = buildHajjCatalogFromDB(
    cat.hajjPrograms,
    ind?.hajjHijriDates ?? [],
  )

  // General knowledge + FAQ — use static fallbacks (same text)
  const generalKnowledge = HAJJ_GENERAL_KNOWLEDGE_STATIC
  const faq              = HAJJ_FAQ_STATIC

  const monthOverview = buildUmrahMonthOverview(rawUmrahPrograms)
  const catalog = [umrahCatalog, monthOverview, hajjCatalog, generalKnowledge, faq].filter(Boolean).join('\n\n')

  // Hotels section
  const hotelList = ind?.hotels ?? []
  const hotels    = buildHotelKnowledgeFromData(hotelList)

  const hajjProgramDetails = buildHajjProgramDetailsArray(cat.hajjPrograms)

  const { message: hajjOverviewMessage, orderedDetails: hajjOverviewDetails } =
    buildHajjOverviewMessage(cat.hajjPrograms)

  const hajjCategoryQuestion = buildHajjCategoryQuestion()
  const { message: hajjEconomyPrograms, orderedDetails: hajjEconomyDetails } =
    buildHajjCategoryPrograms('ECONOMY', cat.hajjPrograms, HAJJ_OV_DISCLAIMER)
  const { message: hajjFiveStarPrograms, orderedDetails: hajjFiveStarDetails } =
    buildHajjCategoryPrograms('FIVE_STAR', cat.hajjPrograms, HAJJ_OV_DISCLAIMER)

  const umrahMonthMessages: Record<string, string> = {}
  const umrahMonthDetails: Record<string, string[]> = {}
  for (const mon of ['يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر']) {
    const { message, orderedDetails } = buildUmrahMonthMessage(mon, rawUmrahPrograms)
    if (message) { umrahMonthMessages[mon] = message; umrahMonthDetails[mon] = orderedDetails }
  }

  const umrahMonthLevelMessages: Record<string, Record<string, string>> = {}
  for (const mon of ['يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر']) {
    for (const lev of UMRAH_LEVEL_ORDER) {
      const { message } = buildUmrahMonthMessage(mon, rawUmrahPrograms, lev)
      if (message) {
        if (!umrahMonthLevelMessages[mon]) umrahMonthLevelMessages[mon] = {}
        umrahMonthLevelMessages[mon][lev] = message
      }
    }
  }

  const { message: umrahAllMonthsMessage, orderedDetails: umrahAllMonthsDetails } =
    buildUmrahAllMonthsOverview(rawUmrahPrograms)

  // ── Batch-1 handler fields ──────────────────────────────────────────────────
  const tpls = (config.templates ?? {}) as Record<string, string>
  const hijriYear = '١٤٤٨'
  const ctaTemplate = tpls['ctaTemplate'] ?? DEFAULT_CTA_TEMPLATE
  const ctaReply = buildCTAReply(ctaTemplate, companyName, rawUmrahPrograms, hijriYear)
  const installmentReply = tpls['installmentPolicy'] ?? ''

  const availableDurations = getAvailableUmrahDurations(rawUmrahPrograms)
  const durationPivotMsg = buildDurationPivotMsg(availableDurations)

  const umrahDurationMessages: Record<number, string> = {}
  const umrahDurationDetails: Record<number, string[]> = {}
  for (const d of availableDurations) {
    const { message, orderedDetails } = buildUmrahDurationMessage(d, rawUmrahPrograms)
    if (message) { umrahDurationMessages[d] = message; umrahDurationDetails[d] = orderedDetails }
  }

  return {
    identity, catalog, hotels, hotelList, monthOverviews: monthOverview,
    hajjProgramDetails, hajjOverviewMessage, hajjOverviewDetails,
    hajjCategoryQuestion, hajjEconomyPrograms, hajjEconomyDetails,
    hajjFiveStarPrograms, hajjFiveStarDetails,
    umrahMonthMessages, umrahMonthDetails, umrahMonthLevelMessages,
    umrahAllMonthsMessage, umrahAllMonthsDetails,
    ctaReply, installmentReply,
    umrahDurationMessages, umrahDurationDetails, availableDurations, durationPivotMsg,
  }
}

