import { Industry } from '@prisma/client';
import { buildHajjUmrahIdentity, buildHajjUmrahCatalog } from './hajj-umrah';

export function getIndustryPrompt(
  industry: Industry,
  companyName: string,
): { identity: string; catalog: string } {
  switch (industry) {
    case Industry.HAJJ_UMRAH:
    default:
      return {
        identity: buildHajjUmrahIdentity(companyName),
        catalog: buildHajjUmrahCatalog(),
      };
  }
}
