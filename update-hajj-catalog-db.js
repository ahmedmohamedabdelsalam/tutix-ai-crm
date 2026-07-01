import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import pg from 'pg'
import * as dotenv from 'dotenv'
dotenv.config()

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const adapter = new PrismaPg(pool)
const prisma = new PrismaClient({ adapter })

const NEW_CATALOG = [
  {
    name: 'برنامج الحج البري',
    type: 'hajj',
    price: 239000,
    currency: 'EGP',
    priceNote: 'بدون تذكرة العبّارة',
    transport: 'باص',
    medina: { hotel: 'فندق أوديست (المنطقة الشمالية)', nights: '١ إلى ٤ ذي الحجة', roomType: 'رباعي/خماسي', meals: 'إفطار وعشاء أوبن بوفيه' },
    mecca: { hotel: 'فندق مواسم الخير (العزيزية)', nights: '٤ إلى ١٤ ذي الحجة', roomType: 'رباعي/خماسي', meals: 'إفطار وعشاء' },
    arafat: 'مخيمات اقتصادية',
    mina: 'مخيمات منى المطورة',
    enhancement: { hotel: 'موفنبيك هاجر (برج الساعة)', nights: '١٤ إلى ٢٠ ذي الحجة', meals: 'إفطار أوبن بوفيه' },
  },
  {
    name: 'برنامج حج اقتصادي - تحسين ٥ نجوم',
    type: 'hajj',
    price: 255000,
    currency: 'EGP',
    priceNote: 'بدون تذكرة الطيران',
    transport: 'قطار الحرمين السريع',
    medina: { hotel: 'فندق أوديست (المنطقة الشمالية)', nights: '٢ إلى ٦ ذي الحجة', roomType: 'رباعي/خماسي', meals: 'إفطار وعشاء أوبن بوفيه' },
    mecca: { hotel: 'فندق نزل البشاير (العزيزية)', nights: '٦ إلى ١٣ ذي الحجة', roomType: 'رباعي/خماسي', meals: 'إفطار وعشاء' },
    arafat: 'مخيمات اقتصادية',
    mina: 'مخيمات مصر اقتصادي سياحي',
    rituals: 'شامل ٣ وجبات',
    enhancement: { hotel: 'موفنبيك هاجر (برج الساعة)', nights: '١٤ إلى ٢٠ ذي الحجة', meals: 'إفطار أوبن بوفيه' },
  },
  {
    name: 'برنامج أطول فترة تحسين ١٤ يوم - اقتصادي',
    type: 'hajj',
    price: 262000,
    currency: 'EGP',
    priceNote: 'بدون تذكرة الطيران',
    meccaEarly: { hotel: 'أبراج زمزم', nights: '٢٠ ذو القعدة إلى ٤ ذي الحجة', meals: 'إفطار وعشاء' },
    aziziya: '٤ إلى ٨ ذي الحجة',
    mashaaer: '٨ إلى ١٣ ذي الحجة',
    medina: { hotel: 'فندق أوديست', nights: '١٤ إلى ١٧ ذي الحجة', meals: 'إفطار وعشاء' },
  },
  {
    name: 'برنامج ٥ نجوم أ',
    type: 'hajj',
    price: 520000,
    currency: 'EGP',
    priceNote: 'بدون تذكرة الطيران',
    transport: 'قطار الحرمين السريع',
    medina: { hotel: 'فندق الحارثية', nights: '١ إلى ٤ ذي الحجة', meals: 'إفطار وعشاء أوبن بوفيه' },
    mecca: { hotel: 'فندق موفنبيك هاجر (برج الساعة)', nights: '٤ إلى ١٤ ذي الحجة', meals: 'إفطار وعشاء' },
    camps: 'مخيمات ٥ نجوم شاملة ٣ وجبات',
  },
  {
    name: 'برنامج اقتصادي أطول فترة تحسين ١٤ يوم',
    type: 'hajj',
    price: null,
    currency: 'EGP',
    priceNote: 'السعر غير محدد — يتواصل مع المبيعات',
    meccaEarly: { hotel: 'أبراج زمزم', nights: '٢٠ ذو القعدة إلى ٤ ذي الحجة', meals: 'إفطار وعشاء' },
    aziziya: '٤ إلى ٨ ذي الحجة',
    mashaaer: '٨ إلى ١٤ ذي الحجة',
    medina: { hotel: 'فندق أوديست', nights: '١٤ إلى ١٧ ذي الحجة', meals: 'إفطار وعشاء' },
  },
  {
    name: 'برنامج ٥ نجوم ب',
    type: 'hajj',
    price: 495000,
    currency: 'EGP',
    priceNote: 'بدون تذكرة الطيران',
    transport: 'قطار الحرمين السريع',
    medina: { hotel: 'فندق إعمار رويال', nights: '١ إلى ٤ ذي الحجة', meals: 'إفطار وعشاء أوبن بوفيه' },
    mecca: { hotel: 'فندق هيلتون مؤتمرات', nights: '٤ إلى ١٤ ذي الحجة', meals: 'إفطار وعشاء' },
    camps: 'مخيمات ٥ نجوم شاملة ٣ وجبات',
  },
  {
    name: 'برنامج أبراج كدانة - المستوى الكامل',
    type: 'hajj',
    price: 650000,
    currency: 'EGP',
    priceNote: 'بدون تذكرة الطيران',
    transport: 'قطار الحرمين السريع',
    medina: { hotel: 'فندق الحارثية', nights: '١ إلى ٤ ذي الحجة', meals: 'إفطار وعشاء أوبن بوفيه' },
    mecca: { hotel: 'فندق موفنبيك هاجر (برج الساعة)', nights: '٤ إلى ١٤ ذي الحجة', meals: 'إفطار وعشاء أوبن بوفيه' },
    arafat: 'مخيمات ٥ نجوم',
    mina: 'أبراج كدانة',
  },
  {
    name: 'برنامج أبراج كدانة - مستوى سريع',
    type: 'hajj',
    price: 595000,
    currency: 'EGP',
    priceNote: 'بدون تذكرة الطيران',
    transport: 'شامل قطار الحرمين',
    nuskType: 'حج قِران',
    medina: { hotel: 'فندق الحارثية', nights: '٤ إلى ٨ ذي الحجة', meals: 'إفطار وعشاء أوبن بوفيه' },
    mecca: { hotel: 'فندق موفنبيك هاجر', nights: '٨ إلى ١٤ ذي الحجة', meals: 'شامل ٣ وجبات' },
    arafat: 'مخيمات ٥ نجوم',
    mina: 'أبراج كدانة',
  },
  {
    name: 'اقتصادي تحسين - أطول فترة تحسين بين الشركات',
    type: 'hajj',
    price: null,
    currency: 'EGP',
    priceNote: 'السعر غير محدد — يتواصل مع المبيعات',
    transport: 'قطار الحرمين السريع',
    meccaEarly: { hotel: 'أبراج زمزم', nights: '٢٠ ذو القعدة إلى ٤ ذي الحجة' },
    aziziya: '٤ إلى ٨ ذي الحجة',
    arafatDate: 'مغرب ٨ ذي الحجة',
    muzdalifa: true,
    mina: 'مخيمات منى أيام التشريق لرمي الجمرات',
    medina: { hotel: 'فندق أوديست', nights: '١٤ إلى ١٧ ذي الحجة' },
  },
]

async function main() {
  const companyId = process.env.DEFAULT_COMPANY_ID
  if (!companyId) throw new Error('DEFAULT_COMPANY_ID not set')

  const config = await prisma.companyAIConfig.findUnique({ where: { companyId } })
  if (!config) {
    console.log('No CompanyAIConfig found for this company — skipping DB update (USE_DB_CATALOG=false, .ts file is the source of truth)')
    return
  }

  // Build updated catalog JSON: replace hajj programs, keep umrah untouched
  const existingCatalog = config.catalog
  const updatedCatalog = {
    ...existingCatalog,
    hajj: NEW_CATALOG,
    hajjUpdatedAt: new Date().toISOString(),
    hajjProgramCount: NEW_CATALOG.length,
  }

  await prisma.companyAIConfig.update({
    where: { companyId },
    data: { catalog: updatedCatalog, updatedAt: new Date() },
  })

  console.log(`✓ Updated CompanyAIConfig catalog for company ${companyId}`)
  console.log(`  Hajj programs: ${NEW_CATALOG.length}`)
  console.log(`  Programs: ${NEW_CATALOG.map(p => p.name).join(' | ')}`)
}

main().catch(console.error).finally(() => pool.end())
