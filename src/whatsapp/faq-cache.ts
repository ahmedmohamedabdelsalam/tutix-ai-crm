import { PrismaService } from '../prisma/prisma.service'

export interface FAQEntry {
  question: string
  answer:   string
  keywords: any // Json? — string[] when set by admin, null otherwise
}

const faqCache = new Map<string, { data: FAQEntry[]; expiresAt: number }>()

export async function getCompanyFAQ(prisma: PrismaService, companyId: string): Promise<FAQEntry[]> {
  const cached = faqCache.get(companyId)
  if (cached && cached.expiresAt > Date.now()) {
    console.log(`FAQ_CACHE HIT — companyId=${companyId}`)
    return cached.data
  }
  const faqs = await prisma.companyFAQ.findMany({
    where:   { companyId, isActive: true },
    select:  { question: true, answer: true, keywords: true },
    orderBy: { createdAt: 'asc' },
  })
  faqCache.set(companyId, { data: faqs, expiresAt: Date.now() + 10 * 60 * 1000 })
  console.log(`FAQ_CACHE MISS — companyId=${companyId} fetched ${faqs.length} FAQs`)
  return faqs
}

export function invalidateFAQCache(companyId: string): void {
  faqCache.delete(companyId)
}
