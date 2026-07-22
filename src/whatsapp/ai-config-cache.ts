import { PrismaService } from '../prisma/prisma.service'

const cache = new Map<string, { isActive: boolean; expiresAt: number }>()
const TTL_MS = 60_000

// Returns true (AI allowed) if the company has no CompanyAIConfig — absence of config
// means the company never configured the AI kill switch, not that it's been turned off.
export async function isAIConfigActive(
  prisma: PrismaService,
  companyId: string,
): Promise<boolean> {
  const hit = cache.get(companyId)
  if (hit && hit.expiresAt > Date.now()) return hit.isActive

  const config = await prisma.companyAIConfig.findUnique({
    where: { companyId },
    select: { isActive: true },
  })
  const active = config?.isActive ?? true
  cache.set(companyId, { isActive: active, expiresAt: Date.now() + TTL_MS })
  console.log(`AI_CONFIG_CACHE MISS — companyId=${companyId} isActive=${active}`)
  return active
}
