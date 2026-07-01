require('dotenv').config();
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');
const { PrismaClient } = require('@prisma/client');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

const ID = 'cmq4ok7hx000004kzfnsxp54o';

prisma.companyAIConfig.findUnique({ where: { companyId: ID } }).then(c => {
  const hotels = c.industryData.hotels;
  console.log('All hotel names with first-char codepoints:');
  hotels.forEach(h => {
    const hex = [...h.name].map(ch => 'U+' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4,'0')).join(' ');
    const hasLink = h.bookingLink ? '✓' : '✗';
    console.log(hasLink, JSON.stringify(h.name), '->', hex.substring(0, 60));
  });
}).catch(console.error).finally(() => { prisma.$disconnect(); pool.end(); });
