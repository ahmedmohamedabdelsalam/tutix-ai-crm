import { PrismaService } from '../prisma/prisma.service'
import { PrebuiltCatalog } from '../agent/agent.service'
import { buildIndustryPromptFromDB, FieldDef } from '../agent/prompts/dynamic-catalog-builder'

// Accepts true / "true" / 'true' / TRUE / 1 / yes — any surrounding quotes or casing variant.
// Guards against Railway (and similar platforms) that store flag vars as `"true"` with literal quotes.
function resolveFlag(raw: string | undefined): boolean {
  if (!raw) return false
  const n = raw.replace(/^["']|["']$/g, '').trim().toLowerCase()
  return n === 'true' || n === '1' || n === 'yes'
}

const USE_DB_CATALOG_RESOLVED = resolveFlag(process.env.USE_DB_CATALOG)
console.log(
  `[STARTUP] USE_DB_CATALOG raw="${process.env.USE_DB_CATALOG ?? ''}" → resolved=${USE_DB_CATALOG_RESOLVED}`,
)

// In-memory per-company catalog cache.  TTL = 5 minutes.
// Invalidated explicitly by invalidateCatalogCache() — call this wherever
// Offering or OfferingType rows are written so the next request rebuilds.
const CACHE_TTL_MS = 5 * 60 * 1000
const cache = new Map<string, { result: PrebuiltCatalog; expiresAt: number }>()

export function invalidateCatalogCache(companyId: string): void {
  cache.delete(companyId)
  console.log(`CATALOG_CACHE: invalidated for companyId=${companyId}`)
}

export async function getPrebuiltCatalog(
  prisma: PrismaService,
  companyId: string,
  companyName: string,
): Promise<PrebuiltCatalog | undefined> {
  if (!USE_DB_CATALOG_RESOLVED) return undefined

  const now = Date.now()
  const cached = cache.get(companyId)
  if (cached && cached.expiresAt > now) {
    console.log(`CATALOG_CACHE: hit for companyId=${companyId}`)
    return cached.result
  }

  const config = await prisma.companyAIConfig.findUnique({ where: { companyId } })
  if (!config) { console.log(`DB_CATALOG: no config for companyId=${companyId}`); return undefined }

  // Fetch عمرة OfferingType + its active Offerings.
  // Guard: if none exist, offeringsOverride stays undefined → falls back to catalog.umrahPrograms.
  // FROZEN LEGACY SAFETY NET (2026-07-28): /admin/catalog was removed in Phase B2.
  // catalog.umrahPrograms is no longer edited by any UI. For companies that have
  // migrated to the Offerings table the fallback is never reached. For companies
  // that have no OfferingType yet, the frozen JSON keeps them from going dark.
  // Do NOT delete this fallback until every active company has Offerings rows.
  let offeringsOverride: Array<{ values: Record<string, unknown>; fieldDefs: FieldDef[] }> | undefined

  const offeringType = await prisma.offeringType.findFirst({
    where: { companyId, name: 'عمرة', isActive: true },
  })

  if (offeringType) {
    const offerings = await prisma.offering.findMany({
      where: { companyId, offeringTypeId: offeringType.id, isActive: true },
      orderBy: { sortOrder: 'asc' },
    })
    if (offerings.length > 0) {
      const fieldDefs = offeringType.fieldDefs as unknown as FieldDef[]
      offeringsOverride = offerings.map(o => ({
        values:    o.values    as Record<string, unknown>,
        fieldDefs,
      }))
      console.log(`DB_CATALOG: Offerings path — ${offerings.length} offerings for companyId=${companyId}`)
    } else {
      console.log(`DB_CATALOG: OfferingType "عمرة" exists but has 0 active offerings — falling back to catalog.umrahPrograms`)
    }
  }

  console.log(`DB_CATALOG: building catalog for config id=${config.id} company=${companyName}`)
  const result = buildIndustryPromptFromDB(config as any, companyName, offeringsOverride)

  cache.set(companyId, { result, expiresAt: now + CACHE_TTL_MS })
  return result
}
