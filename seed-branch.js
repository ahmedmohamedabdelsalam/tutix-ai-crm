import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import pg from 'pg'
import * as dotenv from 'dotenv'
dotenv.config()

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const adapter = new PrismaPg(pool)
const prisma = new PrismaClient({ adapter })

async function main() {
  const companyId = process.env.DEFAULT_COMPANY_ID
  if (!companyId) throw new Error('DEFAULT_COMPANY_ID not set')

  const existing = await prisma.branch.findFirst({ where: { companyId } })
  if (existing) {
    console.log('Branch already exists:', existing.name, existing.id)
    return
  }

  const branch = await prisma.branch.create({
    data: {
      companyId,
      name: 'الفرع الرئيسي - بورسعيد',
      lat: 31.439500,
      lng: 31.678472,
      radiusMeters: 200,
    },
  })
  console.log('Created branch:', branch.id, branch.name)
}

main().catch(console.error).finally(() => pool.end())
