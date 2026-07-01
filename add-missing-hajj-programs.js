/**
 * add-missing-hajj-programs.js
 *
 * Appends 3 missing Hajj programs to cat.hajjPrograms in CompanyAIConfig for Alex.
 * The 3 programs existed in the static hajj-packages.ts but were not included in
 * the original migrate-alex-ai-config.js (which stored 6 programs).
 *
 * Run: node add-missing-hajj-programs.js
 */
require('dotenv').config();
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');
const { PrismaClient } = require('@prisma/client');

const ALEX_COMPANY_ID = 'cmq4ok7hx000004kzfnsxp54o';

// 3 missing programs in the exact same HajjProgram structured format
// as the existing 6 in cat.hajjPrograms.
// pricePerPerson: 0 means "السعر غير محدد" — handled by the renderer.
// The itinerary is stored in highlights[] because these programs have a
// non-standard order (start in Mecca, end in Medina) which doesn't map
// cleanly to the medina-first structured fields.
const MISSING_PROGRAMS = [
  {
    id: 'long-enhancement-14-ekonomi',
    name: 'برنامج أطول فترة تحسين ١٤ يوم - اقتصادي',
    pricePerPerson: 262000,
    transportationType: 'جوي',
    haramainTrain: false,
    includesAirTicket: false,
    ticketType: 'طيران',
    highlights: [
      'مكة المكرمة: ٢٠ ذو القعدة إلى ٤ ذي الحجة ١٤٤٨هـ تقريباً (الموافق ٢٧ أبريل-١٠ مايو ٢٠٢٧م) | أبراج زمزم | إفطار وعشاء',
      'العزيزية: ٤ إلى ٨ ذي الحجة ١٤٤٨هـ تقريباً (الموافق ١٠-١٤ مايو ٢٠٢٧م)',
      'المشاعر ومنى وعرفات: ٨ إلى ١٣ ذي الحجة ١٤٤٨هـ تقريباً (الموافق ١٤-١٩ مايو ٢٠٢٧م)',
      'المدينة المنورة: ١٤ إلى ١٧ ذي الحجة ١٤٤٨هـ تقريباً (الموافق ٢٠-٢٣ مايو ٢٠٢٧م) | فندق أوديست | إفطار وعشاء',
    ],
    scholarNote: null,
  },
  {
    id: 'long-enhancement-14-ekonomi-b',
    name: 'برنامج اقتصادي أطول فترة تحسين ١٤ يوم',
    pricePerPerson: 0,
    transportationType: 'جوي',
    haramainTrain: false,
    includesAirTicket: false,
    ticketType: 'طيران',
    highlights: [
      'مكة المكرمة: ٢٠ ذو القعدة إلى ٤ ذي الحجة ١٤٤٨هـ تقريباً (الموافق ٢٧ أبريل-١٠ مايو ٢٠٢٧م) | أبراج زمزم | إفطار وعشاء',
      'العزيزية: ٤ إلى ٨ ذي الحجة ١٤٤٨هـ تقريباً (الموافق ١٠-١٤ مايو ٢٠٢٧م)',
      'المشاعر ومنى وعرفات: ٨ إلى ١٤ ذي الحجة ١٤٤٨هـ تقريباً (الموافق ١٤-٢٠ مايو ٢٠٢٧م)',
      'المدينة المنورة: ١٤ إلى ١٧ ذي الحجة ١٤٤٨هـ تقريباً (الموافق ٢٠-٢٣ مايو ٢٠٢٧م) | فندق أوديست | إفطار وعشاء',
    ],
    scholarNote: null,
  },
  {
    id: 'longest-enhancement-ekonomi',
    name: 'اقتصادي تحسين - أطول فترة تحسين بين الشركات',
    pricePerPerson: 0,
    transportationType: 'جوي',
    haramainTrain: true,
    includesAirTicket: false,
    ticketType: 'طيران',
    highlights: [
      'مكة المكرمة: ٢٠ ذو القعدة إلى ٤ ذي الحجة ١٤٤٨هـ تقريباً (الموافق ٢٧ أبريل-١٠ مايو ٢٠٢٧م) | أبراج زمزم',
      'العزيزية: ٤ إلى ٨ ذي الحجة ١٤٤٨هـ تقريباً (الموافق ١٠-١٤ مايو ٢٠٢٧م)',
      'التصعيد لعرفات مغرب ٨ ذي الحجة ١٤٤٨هـ تقريباً (الموافق ١٤ مايو ٢٠٢٧م)',
      'المبيت في المزدلفة | مخيمات منى أيام التشريق لرمي الجمرات',
      'الانتقال بقطار الحرمين السريع إلى المدينة المنورة',
      'المدينة المنورة: ١٤ إلى ١٧ ذي الحجة ١٤٤٨هـ تقريباً (الموافق ٢٠-٢٣ مايو ٢٠٢٧م) | فندق أوديست',
    ],
    scholarNote: null,
  },
];

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  try {
    // Step 1: Read current config
    const config = await prisma.companyAIConfig.findUnique({
      where: { companyId: ALEX_COMPANY_ID },
    });
    if (!config) throw new Error('CompanyAIConfig not found for Alex');

    const catalog = config.catalog;
    const existingPrograms = catalog.hajjPrograms;

    console.log(`Current hajjPrograms count: ${existingPrograms.length} (expected 6)`);
    existingPrograms.forEach(p => console.log(`  • ${p.name} (${p.pricePerPerson ? p.pricePerPerson.toLocaleString() : 'غير محدد'})`));

    // Step 2: Check for duplicate IDs (idempotency)
    const existingIds = new Set(existingPrograms.map(p => p.id));
    const toAdd = MISSING_PROGRAMS.filter(p => {
      if (existingIds.has(p.id)) {
        console.log(`  ⚠️ Already exists, skipping: ${p.id}`);
        return false;
      }
      return true;
    });

    if (toAdd.length === 0) {
      console.log('\n✅ All 3 programs already present — nothing to do.');
      return;
    }

    // Step 3: Append the missing programs
    const updatedPrograms = [...existingPrograms, ...toAdd];

    const updatedCatalog = {
      ...catalog,
      hajjPrograms: updatedPrograms,
    };

    await prisma.companyAIConfig.update({
      where: { companyId: ALEX_COMPANY_ID },
      data: { catalog: updatedCatalog, updatedAt: new Date() },
    });

    console.log(`\n✅ Updated hajjPrograms: ${existingPrograms.length} → ${updatedPrograms.length} programs`);

    // Step 4: Verify
    const verified = await prisma.companyAIConfig.findUnique({
      where: { companyId: ALEX_COMPANY_ID },
    });
    const verifiedPrograms = verified.catalog.hajjPrograms;

    console.log(`\n── VERIFICATION ──────────────────────────────────────────────`);
    console.log(`Total hajjPrograms: ${verifiedPrograms.length} (expected 9) ${verifiedPrograms.length === 9 ? '✅' : '❌'}`);

    const prog262 = verifiedPrograms.find(p => p.id === 'long-enhancement-14-ekonomi');
    console.log(`برنامج أطول فترة تحسين ١٤ يوم (262k): ${prog262 ? '✅' : '❌'}`);
    if (prog262) console.log(`  price: ${prog262.pricePerPerson} → expected 262000`);

    const progB = verifiedPrograms.find(p => p.id === 'long-enhancement-14-ekonomi-b');
    console.log(`برنامج اقتصادي أطول فترة تحسين ١٤ يوم (غير محدد): ${progB ? '✅' : '❌'}`);
    if (progB) console.log(`  price: ${progB.pricePerPerson} → expected 0 (غير محدد)`);

    const progC = verifiedPrograms.find(p => p.id === 'longest-enhancement-ekonomi');
    console.log(`اقتصادي تحسين - أطول فترة تحسين بين الشركات (غير محدد): ${progC ? '✅' : '❌'}`);

    const originalIds = ['bari', 'ekonomi-5star', '5star-a', '5star-b', 'kadana-full', 'kadana-quick'];
    const allOriginalPresent = originalIds.every(id => verifiedPrograms.some(p => p.id === id));
    console.log(`الـ6 برامج الأصلية محفوظة: ${allOriginalPresent ? '✅' : '❌'}`);

    if (verifiedPrograms.length === 9 && prog262 && progB && progC && allOriginalPresent) {
      console.log('\n🎉 MIGRATION SUCCESSFUL — catalog.hajjPrograms now has 9 programs');
    } else {
      console.log('\n❌ MIGRATION INCOMPLETE — check errors above');
    }

  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch(err => { console.error('MIGRATION FAILED:', err); process.exit(1); });
