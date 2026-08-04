import { PrismaService } from '../prisma/prisma.service'
import { PrebuiltCatalog } from '../agent/agent.service'
import { buildIndustryPromptFromDB, FieldDef } from '../agent/prompts/dynamic-catalog-builder'

function getCompanyDateISO(tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date())
  } catch {
    return new Date().toISOString().slice(0, 10)
  }
}

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

// H3 bridge flag. OFF by default: hajj keeps reading the frozen
// catalog.hajjPrograms JSON until the byte-identical proof (H4) is accepted and
// the owner flips this deliberately. See docs/hajj-offering-spec.md.
const USE_DB_HAJJ_RESOLVED = resolveFlag(process.env.USE_DB_HAJJ)
console.log(
  `[STARTUP] USE_DB_HAJJ raw="${process.env.USE_DB_HAJJ ?? ''}" → resolved=${USE_DB_HAJJ_RESOLVED}` +
  ` (${USE_DB_HAJJ_RESOLVED ? 'hajj from Offerings table' : 'hajj from catalog.hajjPrograms JSON'})`,
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
    const templates = (config?.templates ?? {}) as Record<string, any>
    const tz: string = (templates?.workingHours?.timezone as string | undefined) ?? 'Africa/Cairo'
    const todayISO = getCompanyDateISO(tz)

    const allOfferings = await prisma.offering.findMany({
      where: { companyId, offeringTypeId: offeringType.id, isActive: true },
      orderBy: { sortOrder: 'asc' },
    })

    const fieldDefs = offeringType.fieldDefs as unknown as FieldDef[]
    const startDateDef = fieldDefs.find((f: FieldDef) => f.role === 'start-date')

    // Keep offerings departing today or in the future. Offerings with no start-date are included.
    const futureOfferings = startDateDef
      ? allOfferings.filter(o => {
          const v = (o.values as Record<string, unknown>)[startDateDef.key]
          return typeof v !== 'string' || v >= todayISO
        })
      : allOfferings

    // Always set offeringsOverride when OfferingType exists (even to []).
    // undefined → no OfferingType → builder falls back to legacy JSON catalog.
    // []        → OfferingType exists but all offerings expired → hasFutureOfferings=false.
    offeringsOverride = futureOfferings.map(o => ({
      values:    o.values as Record<string, unknown>,
      fieldDefs,
    }))

    console.log(`DB_CATALOG: Offerings path — ${allOfferings.length} total, ${futureOfferings.length} future for companyId=${companyId} (today=${todayISO} tz=${tz})`)
  }

  // Hajj bridge (H3). Flag-gated and undefined unless BOTH the flag is on and the
  // حج OfferingType exists — undefined keeps the builder on catalog.hajjPrograms.
  // No date filtering here: hajj freshness is H5 and must use the END date.
  let hajjOverride: Array<{ values: Record<string, unknown> }> | undefined
  if (USE_DB_HAJJ_RESOLVED) {
    const hajjType = await prisma.offeringType.findFirst({
      where: { companyId, name: 'حج', isActive: true },
    })
    if (hajjType) {
      const hajjOfferings = await prisma.offering.findMany({
        where: { companyId, offeringTypeId: hajjType.id, isActive: true },
        orderBy: { sortOrder: 'asc' },
      })
      hajjOverride = hajjOfferings.map(o => ({ values: o.values as Record<string, unknown> }))
      console.log(`DB_CATALOG: Hajj Offerings path — ${hajjOfferings.length} programs for companyId=${companyId}`)
    } else {
      console.warn(`DB_CATALOG: USE_DB_HAJJ is on but no 'حج' OfferingType for companyId=${companyId} — falling back to JSON`)
    }
  }

  console.log(`DB_CATALOG: building catalog for config id=${config.id} company=${companyName}`)
  const result = buildIndustryPromptFromDB(config as any, companyName, offeringsOverride, hajjOverride)

  cache.set(companyId, { result, expiresAt: now + CACHE_TTL_MS })
  return result
}
