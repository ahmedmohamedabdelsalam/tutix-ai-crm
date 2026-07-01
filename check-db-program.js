require('dotenv').config();
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');
const { PrismaClient } = require('@prisma/client');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

prisma.companyAIConfig.findFirst({
  where: { company: { name: { contains: 'إسكندرية' } } },
  select: { catalog: true },
}).then(r => {
  const programs = r.catalog.umrahPrograms;
  console.log('Count:', programs.length);
  console.log('First program keys:', Object.keys(programs[0]));
  console.log('First program:', JSON.stringify(programs[0], null, 2));
}).catch(console.error).finally(() => { prisma.$disconnect(); pool.end(); });
