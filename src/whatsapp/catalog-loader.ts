import { PrismaService } from '../prisma/prisma.service'
import { PrebuiltCatalog } from '../agent/agent.service'
import { buildIndustryPromptFromDB } from '../agent/prompts/dynamic-catalog-builder'

export async function getPrebuiltCatalog(prisma: PrismaService, companyId: string, companyName: string): Promise<PrebuiltCatalog | undefined> {
  if (process.env.USE_DB_CATALOG !== 'true') return undefined
  const config = await prisma.companyAIConfig.findUnique({ where: { companyId } })
  if (!config) { console.log(`DB_CATALOG: no config for companyId=${companyId}`); return undefined }
  console.log(`DB_CATALOG: loaded config id=${config.id} company=${companyName}`)
  return buildIndustryPromptFromDB(config as any, companyName)
}
