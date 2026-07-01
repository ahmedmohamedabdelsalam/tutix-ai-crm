require('dotenv').config();
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');
const { PrismaClient } = require('@prisma/client');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

const ID = 'cmq4ok7hx000004kzfnsxp54o';

// Exact stored names → booking link
const LINK_BY_STORED_NAME = {
  'أوديست المدينة':      'https://www.booking.com/Share-cGbCMAy',
  'موفنبيك برج هاجر':   'https://www.booking.com/Share-zYAacjf',
  'رمادا دار الفائزين': 'https://www.trivago.com/share/ShwM6UtJbZ',
  'فرونتيل الحارثية':   'https://www.booking.com/Share-gFleQHr',
  'جراند بلازا المدينة':'https://www.booking.com/Share-t752OEg',
  'شذا ريجنسي بلازا':   'https://www.booking.com/Share-3JCkDA',
  'أذكي الصفا':          'https://www.google.com/aclk?sa=L&ai=DChsSEwjTnNGfh4CVAxVpg3wGHSJ_JX0YACICCAEQABoCd3M&co=1&gclid=CjwKCAjwuanRBhBSEiwAY5y6V6nzpLJUUHF3VI7gdzu-VUcc5SElm_sXkJKTYF3tto6W4im6n6ZG5hoCGggQAvD_BwE',
};

async function main() {
  const config = await prisma.companyAIConfig.findUnique({ where: { companyId: ID } });
  let hotels = JSON.parse(JSON.stringify(config.industryData.hotels));

  console.log('Before:', hotels.length, 'hotels');

  // Add booking links to existing full-name hotels
  let linked = 0;
  hotels = hotels.map(h => {
    const link = LINK_BY_STORED_NAME[h.name];
    if (link && !h.bookingLink) { linked++; return { ...h, bookingLink: link }; }
    return h;
  });

  console.log('Added links to', linked, 'existing hotels');

  await prisma.companyAIConfig.update({
    where: { companyId: ID },
    data: { industryData: { ...config.industryData, hotels } },
  });

  // Verify
  const updated = await prisma.companyAIConfig.findUnique({ where: { companyId: ID } });
  const updHotels = updated.industryData.hotels;
  const withLinks = updHotels.filter(h => h.bookingLink);
  console.log('\nAfter:', updHotels.length, 'hotels,', withLinks.length, 'with booking links');
  updHotels.forEach(h => {
    const icon = h.bookingLink ? '✓' : '✗';
    const link = h.bookingLink ? h.bookingLink.substring(0, 45) + '...' : '—';
    console.log(icon, h.name, '→', link);
  });

  console.log('\n✅ Done');
}

main().catch(console.error).finally(() => { prisma.$disconnect(); pool.end(); });
