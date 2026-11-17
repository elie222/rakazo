import type { ModelCatalogEntry } from "@rakazo/contracts";

/** Provider-owned decision protocol identifiers and pricing provenance. */
export interface DecisionModelDescriptor {
  provider: string;
  id: string;
  aliases?: readonly string[];
  inputUsdPerMillion: number;
  pricingVersion: string;
  pricingUrl: string;
  catalog?: ModelCatalogEntry;
}
