import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { canonicalPiProviderId } from "@rakazo/contracts";
import { decisionModel } from "./decision-models.js";
import { applyPiModelCompatibility } from "./pi-model-compat.js";
import { maximumModelCallCost } from "./pi-usage.js";

const models = applyPiModelCompatibility(builtinModels());

export const UNPRICED_MODEL_MESSAGE = "Connect your own API key to use this model.";

/** Priced models keep using credits; unpriced models require a member connection. */
export function modelFunding(
  provider: string,
  modelId: string,
  hosted: boolean,
  ownCredential: boolean,
): "credits" | "connection" | "unavailable" {
  const canonicalProvider = canonicalPiProviderId(provider);
  const cost = models.getModel(canonicalProvider, modelId)?.cost;
  const decisionPrice = decisionModel(canonicalProvider, modelId)?.inputUsdPerMillion;
  if (
    hosted &&
    ((cost && maximumModelCallCost(cost, 1, 1) !== undefined) ||
      (decisionPrice !== undefined && Number.isFinite(decisionPrice) && decisionPrice > 0))
  )
    return "credits";
  if (ownCredential) return "connection";
  return "unavailable";
}
