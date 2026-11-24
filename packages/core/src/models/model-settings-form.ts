import type {
  ModelCatalogEntry,
  ModelCredential,
  ModelSettings,
  ThinkingLevel,
} from "@rakazo/contracts";
import {
  canonicalPiProviderId,
  DEFAULT_MODEL_CONTEXT_WINDOW,
  DEFAULT_MODEL_MAX_TOKENS,
  DEFAULT_THINKING_LEVEL,
  modelOutputLeavesInputRoom,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  parseModelContextWindow,
  parseModelMaxImagesPerPrompt,
  parseModelMaxTokens,
  ThinkingLevelSchema,
} from "@rakazo/contracts";
import {
  clampCatalogThinkingLevel,
  compatibleThinkingLevels,
  newestModelsFirst,
} from "./model-providers.js";

type SettingsCredential = Pick<
  ModelCredential,
  | "provider"
  | "modelSettings"
  | "maxTokens"
  | "contextWindow"
  | "reasoning"
  | "visionModelIds"
  | "maxImagesPerPrompt"
>;
type SettingsEntry = Pick<ModelCatalogEntry, "live" | "contextWindow" | "maxTokens">;

/** What a model settings form edits, as the strings and toggles its fields hold. */
export type ModelSettingsFields = {
  contextWindow: string;
  maxTokens: string;
  images: boolean;
  maxImagesPerPrompt: string;
  /** "off" when the model does not think. */
  thinkingLevel: ThinkingLevel;
};

/** A field whose number is out of range; each app words the message. */
export type ModelSettingsInvalidField =
  | "contextWindow"
  | "maxTokens"
  | "outputRoom"
  | "maxImagesPerPrompt";

/**
 * Image input and thinking can be set only where the catalog cannot describe the model: an
 * OpenAI-compatible model, or one a provider lists that the catalog does not know.
 */
export function modelCapabilitiesConfigurable(
  provider: string,
  entry: Pick<ModelCatalogEntry, "live"> | undefined,
): boolean {
  return provider === OPENAI_COMPATIBLE_PROVIDER_ID || !entry || entry.live === true;
}

/** The catalog's entry for a model, matching provider aliases the way runs do. */
export function catalogEntryFor<T extends Pick<ModelCatalogEntry, "provider" | "id">>(
  catalog: readonly T[],
  provider: string,
  modelId: string,
): T | undefined {
  return catalog.find(
    (entry) =>
      canonicalPiProviderId(entry.provider) === canonicalPiProviderId(provider) &&
      entry.id === modelId,
  );
}

/** Whether a model on this connection has settings of its own, not just its card's. */
export function modelHasOwnSettings(
  credential: Pick<ModelCredential, "modelSettings">,
  modelId: string,
): boolean {
  return Object.keys(credential.modelSettings?.[modelId] ?? {}).length > 0;
}

/** One model a connection runs, with the settings saved for it. */
export type ConnectionModel = { id: string; label: string; settings?: ModelSettings };

type ListedCredential = Pick<
  ModelCredential,
  | "id"
  | "provider"
  | "modelId"
  | "enabledModelIds"
  | "modelSettings"
  | "maxTokens"
  | "contextWindow"
>;
type ListedEntry = Pick<
  ModelCatalogEntry,
  "provider" | "id" | "label" | "placeholder" | "credentialIds" | "live"
>;

/** Every model a connection can run: a compatible connection's enabled ones, else its catalog's. */
function servedModels(credential: ListedCredential, catalog: readonly ListedEntry[]) {
  return credential.provider === OPENAI_COMPATIBLE_PROVIDER_ID
    ? (credential.enabledModelIds ?? (credential.modelId ? [credential.modelId] : [])).map(
        (id) => ({ id, label: id, entry: undefined }),
      )
    : catalog
        .filter(
          (entry) =>
            canonicalPiProviderId(entry.provider) === canonicalPiProviderId(credential.provider) &&
            !entry.placeholder &&
            (!entry.credentialIds || entry.credentialIds.includes(credential.id)),
        )
        .map((entry) => ({ id: entry.id, label: entry.label, entry }));
}

/** Whether the connection can still run the model, whether or not it has settings to show. */
export function connectionServesModel(
  credential: ListedCredential,
  catalog: readonly ListedEntry[],
  modelId: string,
): boolean {
  return servedModels(credential, catalog).some((model) => model.id === modelId);
}

/**
 * Whether a model on this connection has settings someone may need: any model on a compatible
 * server, one its provider lists that the catalog cannot describe, or one already carrying its
 * own limits or the connection-wide ones saved before models had their own.
 */
export function modelSettingsEditable(
  credential: Pick<ModelCredential, "provider" | "modelSettings" | "maxTokens" | "contextWindow">,
  entry: Pick<ModelCatalogEntry, "live"> | undefined,
  modelId: string,
): boolean {
  return (
    credential.provider === OPENAI_COMPATIBLE_PROVIDER_ID ||
    entry?.live === true ||
    modelHasOwnSettings(credential, modelId) ||
    credential.maxTokens !== undefined ||
    credential.contextWindow !== undefined
  );
}

/**
 * The models on a connection whose settings someone may need to set (`modelSettingsEditable`).
 * Models with their own settings come first, then a catalog's newest first.
 */
export function connectionModels(
  credential: ListedCredential,
  catalog: readonly ListedEntry[],
): ConnectionModel[] {
  const models = servedModels(credential, catalog)
    .filter((model) => modelSettingsEditable(credential, model.entry, model.id))
    .map(({ id, label }) => ({
      id,
      label,
      ...(modelHasOwnSettings(credential, id) ? { settings: credential.modelSettings?.[id] } : {}),
    }));
  const ordered =
    credential.provider === OPENAI_COMPATIBLE_PROVIDER_ID ? models : newestModelsFirst(models);
  return [
    ...ordered.filter((model) => model.settings),
    ...ordered.filter((model) => !model.settings),
  ];
}

/** The values a model runs with when its fields are left empty. */
export function modelSettingsDefaults(
  provider: string,
  entry: SettingsEntry | undefined,
): { contextWindow?: number; maxTokens?: number } {
  if (provider === OPENAI_COMPATIBLE_PROVIDER_ID)
    return { contextWindow: DEFAULT_MODEL_CONTEXT_WINDOW, maxTokens: DEFAULT_MODEL_MAX_TOKENS };
  return { contextWindow: entry?.contextWindow, maxTokens: entry?.maxTokens };
}

/**
 * The settings a model on this connection runs with: its own, else the values that were saved
 * for the whole connection before models had their own.
 */
export function credentialModelSettings(
  credential: SettingsCredential,
  modelId: string,
): ModelSettings {
  const own = credential.modelSettings?.[modelId];
  if (own) return own;
  const compatible = credential.provider === OPENAI_COMPATIBLE_PROVIDER_ID;
  return {
    ...(credential.maxTokens !== undefined ? { maxTokens: credential.maxTokens } : {}),
    ...(credential.contextWindow !== undefined ? { contextWindow: credential.contextWindow } : {}),
    ...(compatible && credential.reasoning ? { reasoning: true } : {}),
    ...(compatible && credential.visionModelIds?.includes(modelId) ? { images: true } : {}),
    ...(compatible && credential.maxImagesPerPrompt !== undefined
      ? { maxImagesPerPrompt: credential.maxImagesPerPrompt }
      : {}),
  };
}

/**
 * The efforts a model offers. An OpenAI-compatible model offers its endpoint's once its own
 * settings say it thinks; any other model offers the catalog's.
 */
export function modelThinkingLevels(
  credential: (SettingsCredential & Pick<ModelCredential, "apiProtocol">) | undefined,
  entry: Pick<ModelCatalogEntry, "thinkingLevels" | "defaultCapabilities"> | undefined,
  modelId: string | null | undefined,
): ThinkingLevel[] {
  if (credential && modelId && entry?.defaultCapabilities) {
    const reasoning =
      credentialModelSettings(credential, modelId).reasoning ?? entry.defaultCapabilities.reasoning;
    return reasoning ? (entry.defaultCapabilities.thinkingLevels ?? []) : ["off"];
  }
  if (credential?.provider !== OPENAI_COMPATIBLE_PROVIDER_ID || !modelId)
    return entry?.thinkingLevels ?? [];
  return credentialModelSettings(credential, modelId).reasoning
    ? [...compatibleThinkingLevels(credential.apiProtocol)]
    : [];
}

/**
 * The levels a model's settings may pick for it to think at, "off" first: the ones a listed model
 * borrows from the catalog, else the ones its live entry offers, else its endpoint's.
 */
export function modelSettingsThinkingLevels(
  credential: Pick<ModelCredential, "apiProtocol">,
  entry: Pick<ModelCatalogEntry, "defaultCapabilities" | "thinkingLevels"> | undefined,
): ThinkingLevel[] {
  const levels =
    (entry?.defaultCapabilities
      ? entry.defaultCapabilities.thinkingLevels
      : entry?.thinkingLevels) ?? compatibleThinkingLevels(credential.apiProtocol);
  return ["off", ...levels.filter((level) => level !== "off")];
}

/**
 * The level a model runs at when no chat, bot or role picks one, before the runtime's default:
 * its own, else the one its connection keeps for the connection's own model. Unknown stored
 * levels are ignored.
 */
export function savedThinkingLevel(
  own: ThinkingLevel | undefined,
  connection: { modelId?: string | null; thinkingLevel?: string | null } | undefined,
  modelId: string | null | undefined,
): ThinkingLevel | null {
  if (own) return own;
  if (!modelId || connection?.modelId !== modelId) return null;
  return ThinkingLevelSchema.safeParse(connection.thinkingLevel).data ?? null;
}

/**
 * The level a model thinks at when no chat, bot or role picks one, moved to the nearest of
 * `levels` when given, as the runtime does.
 */
export function modelDefaultThinkingLevel(
  credential: (SettingsCredential & Pick<ModelCredential, "modelId" | "thinkingLevel">) | undefined,
  modelId: string | null | undefined,
  levels?: readonly ThinkingLevel[],
): ThinkingLevel {
  const own = credential && modelId ? credentialModelSettings(credential, modelId) : undefined;
  const level =
    savedThinkingLevel(own?.thinkingLevel, credential, modelId) ?? DEFAULT_THINKING_LEVEL;
  return (clampCatalogThinkingLevel(level, levels) as ThinkingLevel | null) ?? level;
}

/**
 * The fields for a model's settings. Without its own answer for image input or thinking, a
 * field shows what the model already does, so saving a limit never changes either. `thinking`
 * is the level the model runs at and the levels its picker offers.
 */
export function modelSettingsFields(
  settings: ModelSettings,
  entry?: Pick<ModelCatalogEntry, "images" | "reasoning" | "defaultCapabilities">,
  thinking: { level: ThinkingLevel; levels?: readonly ThinkingLevel[] } = {
    level: DEFAULT_THINKING_LEVEL,
  },
): ModelSettingsFields {
  const reasoning = settings.reasoning ?? (entry?.defaultCapabilities ?? entry)?.reasoning ?? false;
  const level = clampCatalogThinkingLevel(
    settings.thinkingLevel ?? thinking.level,
    thinking.levels,
  );
  return {
    contextWindow: settings.contextWindow !== undefined ? String(settings.contextWindow) : "",
    maxTokens: settings.maxTokens !== undefined ? String(settings.maxTokens) : "",
    images: settings.images ?? (entry?.defaultCapabilities ?? entry)?.images ?? false,
    maxImagesPerPrompt:
      settings.maxImagesPerPrompt !== undefined ? String(settings.maxImagesPerPrompt) : "",
    thinkingLevel: reasoning && level ? (level as ThinkingLevel) : "off",
  };
}

export type ModelSettingsRequest =
  | { status: "invalid"; field: ModelSettingsInvalidField }
  | { status: "ready"; settings: ModelSettings };

/**
 * The settings a form saves. Empty fields follow the model card. `followedThinkingLevel` is the
 * level the form opened at for a model without its own; saving it unchanged keeps the model
 * following its connection's level and the default.
 */
export function modelSettingsRequest(input: {
  fields: ModelSettingsFields;
  provider: string;
  entry: SettingsEntry | undefined;
  followedThinkingLevel?: ThinkingLevel;
}): ModelSettingsRequest {
  const { fields, provider, entry, followedThinkingLevel } = input;
  const settings: ModelSettings = {};
  if (fields.contextWindow.trim()) {
    const contextWindow = parseModelContextWindow(fields.contextWindow.trim());
    if (contextWindow === undefined) return { status: "invalid", field: "contextWindow" };
    settings.contextWindow = contextWindow;
  }
  if (fields.maxTokens.trim()) {
    const maxTokens = parseModelMaxTokens(fields.maxTokens.trim());
    if (maxTokens === undefined) return { status: "invalid", field: "maxTokens" };
    settings.maxTokens = maxTokens;
  }
  const defaults = modelSettingsDefaults(provider, entry);
  if (
    (settings.maxTokens !== undefined || settings.contextWindow !== undefined) &&
    !modelOutputLeavesInputRoom(
      settings.maxTokens ?? defaults.maxTokens,
      settings.contextWindow ?? defaults.contextWindow,
    )
  )
    return { status: "invalid", field: "outputRoom" };
  if (modelCapabilitiesConfigurable(provider, entry)) {
    settings.images = fields.images;
    settings.reasoning = fields.thinkingLevel !== "off";
    if (settings.reasoning && fields.thinkingLevel !== followedThinkingLevel)
      settings.thinkingLevel = fields.thinkingLevel;
  }
  if (fields.images && fields.maxImagesPerPrompt.trim()) {
    const maxImagesPerPrompt = parseModelMaxImagesPerPrompt(fields.maxImagesPerPrompt.trim());
    if (maxImagesPerPrompt === undefined) return { status: "invalid", field: "maxImagesPerPrompt" };
    settings.maxImagesPerPrompt = maxImagesPerPrompt;
  }
  return { status: "ready", settings };
}
