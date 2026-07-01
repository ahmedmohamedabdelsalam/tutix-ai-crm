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
import { UmrahProgram, buildUmrahCatalogTableFromData } from './umrah-packages-2026'
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

function buildHajjCatalogFromDB(
  hajjPrograms: HajjProgram[],
  hijriDates: Array<{ hijri: string; gregorian: string }>,
): string {
  const hijriTable = hijriDates
    .map(d => `• ${d.hijri} تقريباً = ${d.gregorian}`)
    .join('\n')

  const programBlocks = hajjPrograms.map(p => {
    const priceLabel = !p.pricePerPerson
      ? `السعر غير محدد (للتواصل مع المبيعات)`
      : p.discountedPrice
        ? `${formatPrice(p.pricePerPerson)} جنيه للفرد (بدون تذكرة ${p.ticketType}) | بعد الخصم: ${formatPrice(p.discountedPrice)} جنيه (خصم ${formatPrice(p.discountAmount ?? 0)} جنيه، ${p.discountNote ?? ''})`
        : `${formatPrice(p.pricePerPerson)} جنيه للفرد (بدون تذكرة ${p.ticketType})`

    const lines: string[] = [`[${p.name}] — ${priceLabel}`]

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
  }).join('\n\n')

  return `## القسم ٣ب — برامج الحج ١٤٤٨هـ (مايو ٢٠٢٧م) (الأسعار للفرد الواحد - بدون تذكرة الطيران أو العبّارة)
⚠️ تنبيه إلزامي: كل سعر حج مذكور هنا هو للفرد الواحد فقط وبدون تذكرة الطيران أو العبّارة — يجب ذكر هذا التوضيح دائماً عند عرض أي سعر.

جدول تحويل تواريخ ذي الحجة ١٤٤٨هـ (تقديرية — يُعلن الرسمي بعد رؤية الهلال):
${hijriTable}

─────────────────────────────────────
${programBlocks}
─────────────────────────────────────

## تعليمات بيع برامج الحج
• الأسعار أعلاه كلها للفرد الواحد وكلها بدون تذكرة الطيران أو العبّارة — هذا التوضيح إلزامي مع كل سعر تذكره
• اسأل عن عدد الأفراد أولاً قبل عرض أي برنامج (نفس مبدأ العمرة)
• اعرض ٢ أو ٣ برامج متنوعة فقط (اقتصادي + متوسط + فاخر) حسب ما تفهمه من ميزانية العميل — لا تعرض الـ٦ برامج دفعة واحدة
• لحساب الإجمالي: السعر للفرد × عدد الأفراد، واذكر دائماً "وده بدون تذكرة الطيران/العبّارة"
• ⛔ قاعدة التواريخ الهجرية للحج ١٤٤٨هـ — إلزامية بدون استثناء: كل مرة تذكر فيها أي تاريخ من جدول ذي الحجة أعلاه في ردّك يجب إضافة كلمة "تقريباً" بعد التاريخ الهجري مباشرة وجملة "وهذا التاريخ يُعلن رسمياً بعد رؤية الهلال قبل الموسم" في نفس الرد
  مثال ملزم حرفي: "يوم عرفة ٩ ذي الحجة ١٤٤٨هـ تقريباً الموافق ١٥ مايو ٢٠٢٧م والتاريخ الرسمي يُعلن بعد رؤية الهلال"
• لو سأل "هل يشمل الطيران؟" — جاوب بوضوح: "لا يافندم السعر ده بدون تذكرة الطيران/العبّارة، التذكرة بتُحسب بشكل منفصل حسب توفرها وقت الحجز"`
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

  // Umrah catalog table (rendered from structured JSON)
  const umrahCatalog = buildUmrahCatalogTableFromData(
    cat.umrahPrograms,
    cat.hotelBookingLinks,
  )

  // Hajj catalog rendered from structured JSON
  const hajjCatalog = buildHajjCatalogFromDB(
    cat.hajjPrograms,
    ind?.hajjHijriDates ?? [],
  )

  // General knowledge + FAQ — use static fallbacks (same text)
  const generalKnowledge = HAJJ_GENERAL_KNOWLEDGE_STATIC
  const faq              = HAJJ_FAQ_STATIC

  const catalog = [umrahCatalog, hajjCatalog, generalKnowledge, faq].join('\n\n')

  // Hotels section
  const hotelList = ind?.hotels ?? []
  const hotels    = buildHotelKnowledgeFromData(hotelList)

  return { identity, catalog, hotels, hotelList }
}

/** Convenience wrapper: find a hotel in a customer message using DB hotel list */
export function findHotelInMessageDB(message: string, config: CompanyAIConfig): string | null {
  const ind = config.industryData as unknown as IndustryDataJson | null
  if (!ind?.hotels) return null
  return findHotelInMessageFromData(message, ind.hotels)
}
