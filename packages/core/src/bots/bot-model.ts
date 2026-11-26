import type { ModelCatalogEntry, ModelCredential, ThinkingLevel } from "@rakazo/contracts";
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
 * A bot's model as its pickers show it: the models it can switch to, its own model as the catalog
 * names it today (`modelKey` is "" while it follows the Space default), the model in effect
 * (`shownKey`), the short name a compact picker shows, and the thinking levels it offers.
 */
export function botModelState({
  credentials,
  catalog,
  me,
  modelKey,
}: {
  credentials: readonly ModelCredential[];
  catalog: readonly ModelCatalogEntry[];
  me: SpaceDefault | null;
  modelKey: string;
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
  const defaultModelKey =
    me?.defaultProvider && me.defaultModel
      ? modelOptionKey(
          me.defaultProvider,
          resolveSelectableModelId(catalog, me.defaultProvider, me.defaultModel),
        )
      : "";
  // The model in effect: the bot's, or the Space default's while it follows it.
  const shownKey = selectedModelKey || defaultModelKey;
  const connected = connectedModelChoices(credentials, catalog);
  // The Space default's model is always listed, so a pinned bot can go back to following it.
  const choices = chatModelChoices(connected, defaultModelKey, {
    label: defaultEntry?.label,
    images: defaultEntry?.images,
  });
  if (!choices.some((choice) => choice.key === shownKey)) {
    choices.unshift(...chatModelChoices([], shownKey));
  }
  const shown = choices.find((choice) => choice.key === shownKey);
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
  const onLevels = modelThinkingLevels(credential, entry, modelId).filter(
    (level) => level !== "off",
  );
  const defaultThinkingLevel = modelDefaultThinkingLevel(credential, modelId, onLevels);
  // Off is listed only when it is the model's default, so the level in use can always be picked.
  const thinkingLevels: ThinkingLevel[] =
    onLevels.length && defaultThinkingLevel === "off" ? ["off", ...onLevels] : onLevels;

  return {
    selectedModel,
    selectedModelKey,
    shownKey,
    defaultEntry,
    choices,
    /** The model key to save for a pick: "" for the Space default's, so the bot keeps following it. */
    savedModelKey: (key: string) => (key === defaultModelKey ? "" : key),
    /** No connected provider offers a model, so a picker should offer to connect one. */
    nothingConnected: connected.length === 0,
    selectedName,
    selectedMark,
    thinkingLevels,
    defaultThinkingLevel,
    /** The level to save for a pick: none for the model's default, so the bot keeps following it. */
    savedThinkingLevel: (level: ThinkingLevel) => (level === defaultThinkingLevel ? null : level),
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
