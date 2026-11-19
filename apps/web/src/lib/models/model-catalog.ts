import type { ModelCatalogEntry, ModelCredential } from "@rakazo/contracts";
import type { ConnectedModelChoice } from "@rakazo/core";
import { connectedModelChoices } from "@rakazo/core";

export { modelOptionKey, parseModelOptionKey } from "@rakazo/core";

/** The models the connected credentials can run, as one list for a picker. */
export function connectedModelOptions(
  credentials: ModelCredential[],
  catalog: ModelCatalogEntry[],
): ConnectedModelChoice[] {
  return connectedModelChoices(credentials, catalog);
}
