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
  modelOutputLeavesInputRoom,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  parseModelContextWindow,
  parseModelMaxImagesPerPrompt,
  parseModelMaxTokens,
} from "@rakazo/contracts";
import { compatibleThinkingLevels } from "./model-providers.js";

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
  reasoning: boolean;
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

/**
 * The version a model id starts with, such as `[6, 1]` for `gpt-6.1-sol` or `[4, 5]` for
 * `x-4-5`. A part followed by letters is a size or variant, as in `llama-3-8b`, not a version.
 */
function modelVersion(id: string): number[] {
  const match = /\d+(?:[.-]\d{1,2}(?![\da-z]))*/i.exec(id);
  return match ? match[0].split(/[.-]/).map(Number) : [];
}

/** Models with a higher version in their id first; the catalog's order otherwise stays. */
export function newestModelsFirst<T extends { id: string }>(models: readonly T[]): T[] {
  const versions = new Map(models.map((model) => [model.id, modelVersion(model.id)]));
  return [...models].sort((left, right) => {
    const a = versions.get(left.id) ?? [];
    const b = versions.get(right.id) ?? [];
    for (let index = 0; index < Math.max(a.length, b.length); index++) {
      const difference = (b[index] ?? -1) - (a[index] ?? -1);
      if (difference) return difference;
    }
    return 0;
  });
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
 * The fields for a model's settings. Without its own answer for image input or thinking, a
 * switch shows what the model already does, so saving a limit never turns either off.
 */
export function modelSettingsFields(
  settings: ModelSettings,
  entry?: Pick<ModelCatalogEntry, "images" | "reasoning" | "defaultCapabilities">,
): ModelSettingsFields {
  return {
    contextWindow: settings.contextWindow !== undefined ? String(settings.contextWindow) : "",
    maxTokens: settings.maxTokens !== undefined ? String(settings.maxTokens) : "",
    images: settings.images ?? (entry?.defaultCapabilities ?? entry)?.images ?? false,
    maxImagesPerPrompt:
      settings.maxImagesPerPrompt !== undefined ? String(settings.maxImagesPerPrompt) : "",
    reasoning: settings.reasoning ?? (entry?.defaultCapabilities ?? entry)?.reasoning ?? false,
  };
}

export type ModelSettingsRequest =
  | { status: "invalid"; field: ModelSettingsInvalidField }
  | { status: "ready"; settings: ModelSettings };

/** The settings a form saves. Empty fields follow the model card. */
export function modelSettingsRequest(input: {
  fields: ModelSettingsFields;
  provider: string;
  entry: SettingsEntry | undefined;
}): ModelSettingsRequest {
  const { fields, provider, entry } = input;
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
    settings.reasoning = fields.reasoning;
  }
  if (fields.images && fields.maxImagesPerPrompt.trim()) {
    const maxImagesPerPrompt = parseModelMaxImagesPerPrompt(fields.maxImagesPerPrompt.trim());
    if (maxImagesPerPrompt === undefined) return { status: "invalid", field: "maxImagesPerPrompt" };
    settings.maxImagesPerPrompt = maxImagesPerPrompt;
  }
  return { status: "ready", settings };
}
