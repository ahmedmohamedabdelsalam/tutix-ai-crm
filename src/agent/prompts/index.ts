import { Industry } from '@prisma/client';
import { buildHajjUmrahIdentity, buildHajjUmrahCatalog, buildHajjUmrahHotels } from './hajj-umrah';

export function getIndustryPrompt(
  industry: Industry,
  companyName: string,
): { identity: string; catalog: string; hotels: string } {
  switch (industry) {
    case Industry.HAJJ_UMRAH:
    default:
      return {
        identity: buildHajjUmrahIdentity(companyName),
        catalog: buildHajjUmrahCatalog(),
        hotels: buildHajjUmrahHotels(),
      };
  }
}
