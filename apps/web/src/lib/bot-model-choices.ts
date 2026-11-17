import type { ModelCatalogEntry } from "@rakazo/contracts";
import {
  chatModelChoices,
  connectedModelChoices,
  modelOptionKey,
  parseModelOptionKey,
  resolveSelectableModelId,
} from "@rakazo/core";

type Credentials = Parameters<typeof connectedModelChoices>[0];

/**
 * The models a bot can switch to, with the Space default first, and the bot's own model as the
 * catalog names it today (`modelKey` is "" for the Space default).
 */
export function botModelChoices({
  credentials,
  catalog,
  me,
  modelKey,
  spaceDefaultLabel,
}: {
  credentials: Credentials;
  catalog: ModelCatalogEntry[];
  me: { defaultProvider: string | null; defaultModel: string | null } | null;
  modelKey: string;
  spaceDefaultLabel: string;
}) {
  const stored = modelKey ? parseModelOptionKey(modelKey) : null;
  const selectedModel = stored
    ? {
        provider: stored.provider,
        modelId: resolveSelectableModelId(catalog, stored.provider, stored.modelId),
      }
    : null;
  const selectedModelKey = selectedModel
    ? modelOptionKey(selectedModel.provider, selectedModel.modelId)
    : "";
  const defaultEntry = me?.defaultModel
    ? catalogEntry(catalog, me.defaultProvider, me.defaultModel)
    : undefined;
  const choices = chatModelChoices(
    connectedModelChoices(credentials, catalog),
    selectedModelKey,
    spaceDefaultLabel,
    defaultEntry?.images,
  );
  return { selectedModel, selectedModelKey, defaultEntry, choices };
}

function catalogEntry(
  catalog: ModelCatalogEntry[],
  provider: string | null | undefined,
  modelId: string,
) {
  if (!provider) return undefined;
  return catalog.find((entry) => entry.provider === provider && entry.id === modelId);
}
