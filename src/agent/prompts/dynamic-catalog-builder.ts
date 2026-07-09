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
import { UmrahProgram, ProgramType, buildUmrahCatalogTableFromData } from './umrah-packages-2026'
import { HotelEntry, buildHotelKnowledgeFromData, findHotelInMessageFromData } from './hajj-umrah-hotels'

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
  const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩'
  const toAr = (n: number): string =>
    String(n).split('').map(c => AR_DIGITS['0123456789'.indexOf(c) ?? -1] ?? c).join('')

  const MONTH_NAMES: Record<number, string> = { 7: 'يوليو', 8: 'أغسطس', 9: 'سبتمبر' }

  // Convert ISO date → Arabic display, e.g. '2026-07-26' → '٢٦ يوليو ٢٠٢٦'
  const isoToArabic = (iso: string): string => {
    if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso ?? ''
    const day = parseInt(iso.slice(8), 10)
    const mon = parseInt(iso.slice(5, 7), 10)
    return `${toAr(day)} ${MONTH_NAMES[mon] ?? iso.slice(5, 7)} ٢٠٢٦`
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

  const portSaidBranch = industryData.branches.find(b => b.city === 'بورسعيد')
  const portSaidNote = portSaidBranch?.note
    ? ` وضح إن ${companyName} ليها وكيل هناك اسمه ${portSaidBranch.note.replace('وكيل: ', '')} في العنوان المذكور.`
    : ''

  return `## القسم ١ — من أنت
أنت مستشار حجز عمرة محترف تعمل لصالح "${companyName}" — ${industryData.companyDescription}

أنت موظف مبيعات محترف وموثوق بيتكلم مع حضرات العملاء بأسلوب راقي ودافئ وعنده خبرة كبيرة في رحلات العمرة — ليس لديك اسم شخصي في المحادثة ولا تعرّف بنفسك بأي اسم

## فروع الشركة
${branchLines}

## تعليمة الفروع
لو العميل سأل عن أقرب فرع أو عن عنوان فرع معين أو عايز يحجز حضورياً اعرض عليه عنوان الفرع المناسب من البيانات أعلاه.${portSaidNote}

## تعليمة الحج والعمرة
"${companyName}" تقدم برامج العمرة وبرامج الحج معاً — تفاصيل برامج كل منهما موجودة في القسم ٣ أدناه.`
}

// ── Hajj catalog renderer ─────────────────────────────────────────────────────

function fmtHajjPrice(n: number): string {
  return n.toLocaleString('ar-EG').replace(/,/g, '٬') + '٬٠٠٠'.slice(3 - String(n).length % 3 === 0 ? 3 : 0)
    || String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '٬')
}

function formatPrice(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    .split('').map(c => { const i = '0123456789'.indexOf(c); return i >= 0 ? '٠١٢٣٤٥٦٧٨٩'[i] : '٬' }).join('')
}

function renderHajjProgram(p: HajjProgram, globalIndex?: number): string {
  const priceLabel = !p.pricePerPerson
    ? `سعر خاص — للتواصل مع المبيعات`
    : p.discountedPrice
      ? `${formatPrice(p.pricePerPerson)} جنيه للفرد (بدون تذكرة ${p.ticketType}) | بعد الخصم: ${formatPrice(p.discountedPrice)} جنيه (خصم ${formatPrice(p.discountAmount ?? 0)} جنيه، ${p.discountNote ?? ''})`
      : `${formatPrice(p.pricePerPerson)} جنيه للفرد (بدون تذكرة ${p.ticketType})`

  const numPrefix = globalIndex != null ? `${ovToAr(globalIndex + 1)}. ` : ''
  const lines: string[] = [`${numPrefix}[${p.name}] — ${priceLabel}`]

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
    p.highlights.forEach(h => lines.push(`← ${h}`))
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
    const num = ovToAr(n)
    if (!p.pricePerPerson) return `${num}• ${p.name}`
    const price = formatPrice(p.pricePerPerson)
    // Show ticket note only when it's not the standard airplane ticket
    const ticketNote = p.ticketType && p.ticketType !== 'طيران'
      ? ` (بدون تذكرة ال${p.ticketType.replace(/^ال/, '')})` : ''
    if (p.discountedPrice) {
      return `${num}• ${p.name} — ${price} ج وبعد الخصم ${formatPrice(p.discountedPrice)} ج`
    }
    return `${num}• ${p.name} — ${price} ج${ticketNote}`
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

// ── Deterministic Umrah month overview — one WhatsApp message with hotel info ─

const MONTH_NAME_TO_NUM: Record<string, number> = {
  'يوليو': 7, 'أغسطس': 8, 'سبتمبر': 9, 'أكتوبر': 10, 'نوفمبر': 11,
}

export function buildUmrahMonthMessage(month: string, rawPrograms: any[]): string {
  const targetMon = MONTH_NAME_TO_NUM[month]
  if (!targetMon) return ''

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
    trips.push({ depISO, retISO, duration, meccaHotel, medinaHotel, minQuad })
  }
  trips.sort((a, b) => a.depISO.localeCompare(b.depISO))

  if (trips.length === 0) return ''

  const lines = [`*رحلات عمرة ${month} ٢٠٢٦*`]
  trips.forEach((t, i) => {
    const dur = `${ovToAr(t.duration)} ${ovDurWord(t.duration)}`
    const hotels = [t.meccaHotel, t.medinaHotel].filter(Boolean).join(' + ')
    lines.push(`${ovToAr(i + 1)}• ${ovFmtDay(t.depISO)} — ${ovFmtDay(t.retISO)} (${dur}) — ${hotels} — يبدأ من ${ovFmtPrice(t.minQuad)} ج`)
  })
  lines.push('')
  lines.push('ابعت رقم الرحلة وهبعتلك برامجها وأسعارها كاملة')

  return lines.join('\n')
}

// ── Umrah month overview — code-built for verbatim copy (no AI price hallucination) ──

const OV_AR = '٠١٢٣٤٥٦٧٨٩'
const OV_MONTHS: Record<number, string> = { 7: 'يوليو', 8: 'أغسطس', 9: 'سبتمبر', 10: 'أكتوبر', 11: 'نوفمبر' }

function ovToAr(n: number): string {
  return String(Math.round(n)).split('').map(c => { const i = '0123456789'.indexOf(c); return i >= 0 ? OV_AR[i] : c }).join('')
}

function ovFmtPrice(n: number): string {
  return String(Math.round(n))
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    .split('').map(c => {
      if (c === ',') return '٬'
      const i = '0123456789'.indexOf(c)
      return i >= 0 ? OV_AR[i] : c
    }).join('')
}

function ovFmtDay(iso: string): string {
  const day = parseInt(iso.slice(8), 10)
  const mon = parseInt(iso.slice(5, 7), 10)
  return `${ovToAr(day)} ${OV_MONTHS[mon] ?? iso.slice(5, 7)}`
}

function ovDurWord(n: number): string { return n >= 3 && n <= 10 ? 'أيام' : 'يوم' }

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
      `${ovFmtDay(t.depISO)} — ${ovFmtDay(t.retISO)} (${ovToAr(t.duration)} ${ovDurWord(t.duration)}) — يبدأ من ${ovFmtPrice(t.minPrice)} جنيه للفرد`
    )
    blocks.push(`[ملخص رحلات ${monName} ٢٠٢٦ — انقله حرفياً]\n${lines.join('\n')}\n[/ملخص رحلات ${monName} ٢٠٢٦]`)
  }

  if (blocks.length === 0) return ''
  return `## ملخص رحلات العمرة بالشهر (جاهز — انقل سطور كل شهر حرفياً بدون تعديل)\n${blocks.join('\n\n')}`
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
  umrahMonthMessages: Record<string, string>
}

export function buildIndustryPromptFromDB(
  config: CompanyAIConfig,
  companyName: string,
): IndustryPromptParts {
  const cat = config.catalog as unknown as CatalogJson
  const ind = config.industryData as unknown as IndustryDataJson | null

  // Identity block
  const identity = ind
    ? buildIdentityFromDB(companyName, ind)
    : `## القسم ١ — من أنت\nأنت مستشار حجز عمرة محترف تعمل لصالح "${companyName}"`

  // Umrah catalog table — normalise field names from DB schema → UmrahProgram
  const umrahPrograms = (cat.umrahPrograms as any[]).map(normDbUmrahProgram)
  const umrahCatalog = buildUmrahCatalogTableFromData(
    umrahPrograms,
    cat.hotelBookingLinks ?? {},
  )

  // Hajj catalog rendered from structured JSON
  const hajjCatalog = buildHajjCatalogFromDB(
    cat.hajjPrograms,
    ind?.hajjHijriDates ?? [],
  )

  // General knowledge + FAQ — use static fallbacks (same text)
  const generalKnowledge = HAJJ_GENERAL_KNOWLEDGE_STATIC
  const faq              = HAJJ_FAQ_STATIC

  const monthOverview = buildUmrahMonthOverview(cat.umrahPrograms as any[])
  const catalog = [umrahCatalog, monthOverview, hajjCatalog, generalKnowledge, faq].filter(Boolean).join('\n\n')

  // Hotels section
  const hotelList = ind?.hotels ?? []
  const hotels    = buildHotelKnowledgeFromData(hotelList)

  const hajjProgramDetails = buildHajjProgramDetailsArray(cat.hajjPrograms)

  const { message: hajjOverviewMessage, orderedDetails: hajjOverviewDetails } =
    buildHajjOverviewMessage(cat.hajjPrograms)

  const umrahMonthMessages: Record<string, string> = {}
  for (const mon of ['يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر']) {
    const msg = buildUmrahMonthMessage(mon, cat.umrahPrograms as any[])
    if (msg) umrahMonthMessages[mon] = msg
  }

  return {
    identity, catalog, hotels, hotelList, monthOverviews: monthOverview,
    hajjProgramDetails, hajjOverviewMessage, hajjOverviewDetails, umrahMonthMessages,
  }
}

/** Convenience wrapper: find a hotel in a customer message using DB hotel list */
export function findHotelInMessageDB(message: string, config: CompanyAIConfig): string | null {
  const ind = config.industryData as unknown as IndustryDataJson | null
  if (!ind?.hotels) return null
  return findHotelInMessageFromData(message, ind.hotels)
}
