import { PrismaService } from '../prisma/prisma.service'

const activeCache    = new Map<string, { isActive: boolean; expiresAt: number }>()
const templatesCache = new Map<string, { data: any; expiresAt: number }>()
const TTL_MS         = 60_000
const TMPL_TTL_MS    = 5 * 60_000

// Returns false (AI blocked) if the company has no CompanyAIConfig row.
// Fail-closed: a tenant with no config has no catalog, no templates, and no gate run —
// allowing AI replies there would be a misconfigured-path leak, not a working agent.
// Only an explicit isActive=true on an existing row permits AI to reply.
export async function isAIConfigActive(
  prisma: PrismaService,
  companyId: string,
): Promise<boolean> {
  const hit = activeCache.get(companyId)
  if (hit && hit.expiresAt > Date.now()) return hit.isActive

  const config = await prisma.companyAIConfig.findUnique({
    where: { companyId },
    select: { isActive: true },
  })
  const active = config?.isActive ?? false
  activeCache.set(companyId, { isActive: active, expiresAt: Date.now() + TTL_MS })
  console.log(`AI_CONFIG_CACHE MISS — companyId=${companyId} isActive=${active}`)
  return active
}

// Returns CompanyAIConfig.templates (Json?) for working hours and handoff config.
// Shape expected by confidence-router:
//   { workingHours: { start, end, timezone, days? },
//     handoffTemplateInsideHours: string,
//     handoffTemplateOutsideHours: string,
//     blockedCategories?: string[] }
export async function getAIConfigTemplates(
  prisma: PrismaService,
  companyId: string,
): Promise<any | null> {
  const hit = templatesCache.get(companyId)
  if (hit && hit.expiresAt > Date.now()) return hit.data
  const config = await prisma.companyAIConfig.findUnique({
    where:  { companyId },
    select: { templates: true },
  })
  const data = config?.templates ?? null
  templatesCache.set(companyId, { data, expiresAt: Date.now() + TMPL_TTL_MS })
  return data
}

export function invalidateTemplatesCache(companyId: string): void {
  templatesCache.delete(companyId)
}
