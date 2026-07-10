import { PrismaService } from '../prisma/prisma.service'

const faqCache = new Map<string, { data: { question: string; answer: string }[]; expiresAt: number }>()

export async function getCompanyFAQ(prisma: PrismaService, companyId: string): Promise<{ question: string; answer: string }[]> {
  const cached = faqCache.get(companyId)
  if (cached && cached.expiresAt > Date.now()) {
    console.log(`FAQ_CACHE HIT — companyId=${companyId}`)
    return cached.data
  }
  const faqs = await prisma.companyFAQ.findMany({
    where: { companyId, isActive: true },
    select: { question: true, answer: true },
    orderBy: { createdAt: 'asc' },
  })
  faqCache.set(companyId, { data: faqs, expiresAt: Date.now() + 10 * 60 * 1000 })
  console.log(`FAQ_CACHE MISS — companyId=${companyId} fetched ${faqs.length} FAQs`)
  return faqs
}
