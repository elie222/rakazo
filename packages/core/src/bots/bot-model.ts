import type { ModelCatalogEntry, ModelCredential } from "@rakazo/contracts";
import { modelMark } from "../models/model-marks.js";
import {
  chatModelChoices,
  connectedModelChoices,
  credentialForModel,
  modelOptionKey,
  parseModelOptionKey,
  resolveSelectableModelId,
} from "../models/model-providers.js";
import { modelDefaultThinkingLevel, modelThinkingLevels } from "../models/model-settings-form.js";

type SpaceDefault = { defaultProvider: string | null; defaultModel: string | null };

/**
 * A bot's model as its pickers show it: the models it can switch to (the Space default first),
 * its own model as the catalog names it today (`modelKey` is "" for the Space default), the
 * short name a compact picker shows, and the thinking levels the model in effect offers.
 */
export function botModelState({
  credentials,
  catalog,
  me,
  modelKey,
  spaceDefaultLabel,
}: {
  credentials: readonly ModelCredential[];
  catalog: readonly ModelCatalogEntry[];
  me: SpaceDefault | null;
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
  const connected = connectedModelChoices(credentials, catalog);
  const choices = chatModelChoices(
    connected,
    selectedModelKey,
    spaceDefaultLabel,
    defaultEntry?.images,
  );

  // The model in effect as its own row lists it: the bot's, or the Space default's when it follows it.
  const shown = selectedModelKey
    ? choices.find((choice) => choice.key === selectedModelKey)
    : choices.find(
        (choice) =>
          choice.key !== "" &&
          choice.provider === me?.defaultProvider &&
          choice.modelId === me?.defaultModel,
      );
  // Its maker's mark, and its own name without its connection or the product word the mark stands for.
  const selectedMark = modelMark(
    shown ?? {
      provider: me?.defaultProvider,
      modelId: me?.defaultModel,
      modelLabel: defaultEntry?.label,
    },
  );
  const fullName =
    shortModelName(shown?.modelLabel ?? shown?.label) ??
    (selectedModelKey ? undefined : (shortModelName(defaultEntry?.label) ?? me?.defaultModel)) ??
    undefined;
  const family = selectedMark?.family ? `${selectedMark.family} ` : undefined;
  const selectedName =
    family && fullName?.startsWith(family) && fullName.length > family.length
      ? fullName.slice(family.length)
      : fullName;

  const provider = selectedModel?.provider ?? me?.defaultProvider ?? null;
  const modelId = selectedModel?.modelId ?? me?.defaultModel ?? null;
  const entry =
    provider && modelId
      ? catalog.find(
          (item) =>
            item.provider === provider &&
            resolveSelectableModelId(catalog, item.provider, item.id) === modelId,
        )
      : undefined;
  const credential = credentialForModel(credentials, provider, modelId);
  const thinkingLevels = modelThinkingLevels(credential, entry, modelId).filter(
    (level) => level !== "off",
  );
  const defaultThinkingLevel = modelDefaultThinkingLevel(credential, modelId, thinkingLevels);

  return {
    selectedModel,
    selectedModelKey,
    defaultEntry,
    choices,
    /** No connected provider offers a model, so a picker should offer to connect one. */
    nothingConnected: connected.length === 0,
    selectedName,
    selectedMark,
    thinkingLevels,
    defaultThinkingLevel,
  };
}

function catalogEntry(
  catalog: readonly ModelCatalogEntry[],
  provider: string | null | undefined,
  modelId: string,
) {
  if (!provider) return undefined;
  return catalog.find((entry) => entry.provider === provider && entry.id === modelId);
}

/** A catalog label without its "Vendor: " prefix, as the model lists title their rows. */
function shortModelName(label: string | undefined) {
  return label?.match(/^[^:]+: (.+)$/)?.[1] ?? label;
}

/**
 * The bot update for picking a model from a chat picker (`key` "" is the Space default): a new
 * model starts on its own default thinking level, as it does from the bot's settings.
 */
export function botModelPick(key: string) {
  const model = key ? parseModelOptionKey(key) : null;
  return {
    modelProvider: model?.provider ?? null,
    modelId: model?.modelId ?? null,
    thinkingLevel: null,
  };
}
