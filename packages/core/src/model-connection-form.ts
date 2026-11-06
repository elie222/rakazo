import type {
  CacheCapabilities,
  ModelApiProtocol,
  ModelCatalogEntry,
  ModelConnectInput,
  ModelCredential,
  ModelHeaderRow,
  OpenAiCompatibleModelInfo,
  SettingsScope,
  ThinkingLevel,
} from "@rakazo/contracts";
import {
  DEFAULT_MODEL_CONTEXT_WINDOW,
  ModelHeaderRowsSchema,
  modelHeadersInput,
  modelOutputLeavesInputRoom,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  openAiCompatibleConnectReady,
  parseModelContextWindow,
  parseModelMaxImagesPerPrompt,
  parseModelMaxTokens,
  savedCompatibleEndpointMatches,
} from "@rakazo/contracts";
import {
  clampCatalogThinkingLevel,
  compatibleThinkingLevels,
  connectionMaxTokensField,
  pickCatalogModelId,
} from "./model-providers.js";

type CatalogModel = Pick<ModelCatalogEntry, "provider" | "id" | "recommended" | "thinkingLevels">;
type DefaultModel = { defaultProvider: string | null; defaultModel: string | null };

/** What a form reads from a saved connection. */
type SavedConnection = Pick<
  ModelCredential,
  | "modelId"
  | "enabledModelIds"
  | "baseUrl"
  | "apiProtocol"
  | "reasoning"
  | "thinkingLevel"
  | "maxTokens"
  | "contextWindow"
  | "supportsImages"
  | "maxImagesPerPrompt"
  | "accountId"
  | "gatewayId"
>;

/** What a connection form edits, as the strings and toggles its fields hold. */
export type ConnectionFormFields = {
  enabledModelIds: string[];
  baseUrl: string;
  apiProtocol: ModelApiProtocol;
  reasoning: boolean;
  thinkingLevel: ThinkingLevel | null;
  maxTokens: string;
  contextWindow: string;
  supportsImages: boolean;
  maxImagesPerPrompt: string;
  accountId: string;
  gatewayId: string;
};

/**
 * The model a connection form opens on. An OpenAI-compatible connection keeps its own model, so
 * a new one starts empty rather than borrowing another server's. A catalog provider keeps the
 * model on screen while the catalog still lists it, else the connection's, else the default's.
 */
export function connectionFormModelId(input: {
  catalog: readonly CatalogModel[];
  provider: string;
  credential?: Pick<ModelCredential, "modelId">;
  defaults?: DefaultModel | null;
  current?: string;
}): string {
  const { catalog, provider, credential, defaults, current } = input;
  if (provider === OPENAI_COMPATIBLE_PROVIDER_ID) return credential?.modelId ?? "";
  return (
    catalog.find((entry) => entry.provider === provider && entry.id === current)?.id ??
    pickCatalogModelId(
      catalog,
      provider,
      credential?.modelId ??
        (provider === defaults?.defaultProvider ? defaults.defaultModel : null),
    )
  );
}

/**
 * The fields a form shows for a saved connection, or a new one when `credential` is undefined.
 * A stored effort is bound to the model it was saved with, and is clamped to what `modelId` runs.
 */
export function connectionFormFields(input: {
  catalog: readonly CatalogModel[];
  provider: string;
  modelId: string;
  credential?: SavedConnection;
  /** Prefills a new OpenAI-compatible connection, such as a hosted preset. */
  presetBaseUrl?: string;
}): ConnectionFormFields {
  const { catalog, provider, modelId, credential, presetBaseUrl } = input;
  const compatible = provider === OPENAI_COMPATIBLE_PROVIDER_ID;
  const supportedThinking = compatible
    ? credential?.reasoning
      ? compatibleThinkingLevels(credential?.apiProtocol)
      : []
    : catalog.find((entry) => entry.provider === provider && entry.id === modelId)?.thinkingLevels;
  return {
    enabledModelIds: credential?.enabledModelIds ?? [],
    baseUrl: compatible ? (credential?.baseUrl ?? presetBaseUrl ?? "") : "",
    apiProtocol: credential?.apiProtocol ?? "chat-completions",
    reasoning: credential?.reasoning ?? false,
    thinkingLevel: clampCatalogThinkingLevel(
      credential?.modelId === modelId ? credential.thinkingLevel : null,
      supportedThinking,
    ) as ThinkingLevel | null,
    maxTokens: connectionMaxTokensField(provider, credential?.maxTokens),
    contextWindow: String(credential?.contextWindow ?? DEFAULT_MODEL_CONTEXT_WINDOW),
    supportsImages: credential?.supportsImages ?? false,
    maxImagesPerPrompt: String(credential?.maxImagesPerPrompt ?? ""),
    accountId: credential?.accountId ?? "",
    gatewayId: credential?.gatewayId ?? "",
  };
}

/** What a model listing implies for the form; a field the server did not publish is absent. */
export type ProbedModelFields = {
  supportsImages?: boolean;
  reasoning?: boolean;
  /** The form's text field for the context limit. */
  contextWindow?: string;
  /** The form's text field for the output limit, lowered when the context limit leaves it no room. */
  maxTokens?: string;
};

/**
 * Connection form values a model listing implies. Fields the server did not publish are left
 * out, so the user's own values stay. A published context limit that the current output limit
 * would not leave room in lowers the output limit with it, so the form still saves. A one-token
 * context leaves no valid output limit at all, so it is not prefilled.
 */
export function probedModelFields(
  info: OpenAiCompatibleModelInfo | undefined,
  currentMaxTokens: string,
): ProbedModelFields {
  if (!info) return {};
  const fields: ProbedModelFields = {};
  if (info.supportsImages !== undefined) fields.supportsImages = info.supportsImages;
  if (info.reasoning !== undefined) fields.reasoning = info.reasoning;
  if (info.contextWindow !== undefined && info.contextWindow >= 2) {
    fields.contextWindow = String(info.contextWindow);
    const maxTokens = Number(currentMaxTokens);
    if (Number.isInteger(maxTokens) && maxTokens >= info.contextWindow) {
      fields.maxTokens = String(Math.max(1, Math.floor(info.contextWindow / 2)));
    }
  }
  return fields;
}

/** Whether `modelId` is the model the saved connection runs, on the endpoint it was saved for. */
export function isSavedCompatibleModel(
  credential: Pick<ModelCredential, "modelId" | "baseUrl"> | undefined,
  baseUrl: string,
  modelId: string,
): boolean {
  return (
    credential?.modelId === modelId && savedCompatibleEndpointMatches(baseUrl, credential.baseUrl)
  );
}

/** What an OpenAI-compatible form rewrites when a model is picked; a field left out stays. */
export type PickedCompatibleModelFields = ProbedModelFields & {
  maxImagesPerPrompt?: string;
  thinkingLevel: ThinkingLevel | null;
};

/**
 * Form updates for picking a model on an OpenAI-compatible form. The connection's saved model,
 * on its saved endpoint, gets back the settings its owner chose, also after another model's
 * listing values were filled in. Any other model takes what the listing says about it (see
 * `probedModelFields`), and its effort is cleared unless the connection already runs that model.
 */
export function pickedCompatibleModelFields(input: {
  credential?: SavedConnection;
  baseUrl: string;
  modelId: string;
  /** What the endpoint's listing says about `modelId`, if anything. */
  probed: OpenAiCompatibleModelInfo | undefined;
  form: { reasoning: boolean; maxTokens: string; apiProtocol: ModelApiProtocol };
}): PickedCompatibleModelFields {
  const { credential, baseUrl, modelId, probed, form } = input;
  if (credential && isSavedCompatibleModel(credential, baseUrl, modelId)) {
    const saved = connectionFormFields({
      catalog: [],
      provider: OPENAI_COMPATIBLE_PROVIDER_ID,
      modelId,
      credential,
    });
    return {
      reasoning: saved.reasoning,
      supportsImages: saved.supportsImages,
      maxImagesPerPrompt: saved.maxImagesPerPrompt,
      maxTokens: saved.maxTokens,
      contextWindow: saved.contextWindow,
      thinkingLevel: saved.thinkingLevel,
    };
  }
  const fields = probedModelFields(probed, form.maxTokens);
  return {
    ...fields,
    thinkingLevel: clampCatalogThinkingLevel(
      credential?.modelId === modelId ? credential.thinkingLevel : null,
      (fields.reasoning ?? form.reasoning) ? compatibleThinkingLevels(form.apiProtocol) : [],
    ) as ThinkingLevel | null,
  };
}

/** Whether an OpenAI-compatible form can save: a URL, a model, valid headers, and a key if one is needed. */
export function compatibleConnectionReady(input: {
  apiKey: string;
  baseUrl: string;
  modelId: string;
  headerRows: ModelHeaderRow[] | null;
  credential?: Pick<ModelCredential, "hasKey" | "baseUrl">;
  /** The endpoint is a hosted preset, which always needs a key. */
  keyRequired?: boolean;
}): boolean {
  const { apiKey, credential, headerRows, keyRequired, modelId } = input;
  const baseUrl = input.baseUrl.trim();
  return openAiCompatibleConnectReady({
    apiKey:
      apiKey ||
      (credential?.hasKey && savedCompatibleEndpointMatches(baseUrl, credential.baseUrl)
        ? "stored"
        : ""),
    baseUrl,
    modelId:
      headerRows !== null && !ModelHeaderRowsSchema.safeParse(headerRows).success ? "" : modelId,
    keyRequired,
  });
}

export type ConnectionFormDraft = Omit<ConnectionFormFields, "enabledModelIds"> & {
  apiKey: string;
  modelId: string;
  enabledModelIds: readonly string[];
  headerRows: ModelHeaderRow[] | null;
};

/** A field whose number is out of range; each app words the message. */
export type ConnectionFormInvalidField =
  | "maxTokens"
  | "maxImagesPerPrompt"
  | "contextWindow"
  /** Both numbers are valid, but the output limit leaves no room for input in the context. */
  | "maxTokensExceedsContext";

/**
 * The cache capabilities to save for each of these models the listing described. A described
 * model that publishes none is sent as `null`, so a price saved for it earlier is cleared; a
 * model the listing did not describe is left out and keeps what it has.
 */
function probedCacheCapabilities(
  probedModels: ReadonlyMap<string, Pick<OpenAiCompatibleModelInfo, "cacheCapabilities">>,
  modelIds: readonly string[],
): Record<string, CacheCapabilities | null> | undefined {
  const entries = [...new Set(modelIds)].flatMap((id) => {
    const info = probedModels.get(id);
    return info ? [[id, info.cacheCapabilities ?? null] as const] : [];
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export type ModelConnectRequest =
  | { status: "incomplete" }
  | { status: "invalid"; field: ConnectionFormInvalidField }
  | {
      status: "ready";
      input: ModelConnectInput;
      /** A catalog provider's save without a new key: limits and gateway ids only. */
      savingLimitOnly: boolean;
      /** The model the saved connection runs. */
      activeModelId: string;
    };

/**
 * The `models.connect` input for a connection form. `settingsOnly` saves a catalog provider's
 * limits and gateway ids without the key field. `makeDefault` is sent with its scope when set.
 */
export function modelConnectRequest(input: {
  form: ConnectionFormDraft;
  selected: Pick<
    ModelCatalogEntry,
    "provider" | "providerName" | "id" | "thinkingLevels" | "routingFields"
  >;
  credential?: Pick<ModelCredential, "modelId" | "thinkingLevel">;
  credentialId: string | null;
  settingsOnly?: boolean;
  makeDefault?: { makeDefault: boolean; scope: SettingsScope };
  /** What the latest "Find models" probe said about each model, by id. */
  probedModels?: ReadonlyMap<string, OpenAiCompatibleModelInfo>;
}): ModelConnectRequest {
  const {
    form,
    selected,
    credential,
    credentialId,
    settingsOnly = false,
    makeDefault,
    probedModels,
  } = input;
  const compatible = selected.provider === OPENAI_COMPATIBLE_PROVIDER_ID;
  const baseUrl = form.baseUrl.trim();
  const modelId = form.modelId.trim();
  const newKey = settingsOnly ? "" : form.apiKey.trim();
  const savingLimitOnly = !compatible && !newKey;
  const activeModelId = compatible ? modelId : selected.id;
  if (compatible) {
    if (!baseUrl || !modelId) return { status: "incomplete" };
  } else if (savingLimitOnly) {
    if (!credential) return { status: "incomplete" };
  } else if (newKey.length < 8) {
    return { status: "incomplete" };
  }
  const maxTokens = form.maxTokens.trim() ? parseModelMaxTokens(form.maxTokens) : undefined;
  if ((compatible || form.maxTokens.trim()) && maxTokens === undefined) {
    return { status: "invalid", field: "maxTokens" };
  }
  const maxImagesPerPrompt = compatible
    ? parseModelMaxImagesPerPrompt(form.maxImagesPerPrompt, form.supportsImages)
    : undefined;
  if (
    compatible &&
    form.supportsImages &&
    form.maxImagesPerPrompt.trim() &&
    maxImagesPerPrompt === undefined
  ) {
    return { status: "invalid", field: "maxImagesPerPrompt" };
  }
  const contextWindow = compatible ? parseModelContextWindow(form.contextWindow) : undefined;
  if (compatible && contextWindow === undefined) {
    return { status: "invalid", field: "contextWindow" };
  }
  if (compatible && !modelOutputLeavesInputRoom(maxTokens, contextWindow)) {
    return { status: "invalid", field: "maxTokensExceedsContext" };
  }
  const cacheCapabilitiesByModel =
    compatible && probedModels
      ? probedCacheCapabilities(probedModels, [modelId, ...form.enabledModelIds])
      : undefined;
  // The staged effort belongs to the model on screen. Clamp it before a connect or a limit
  // save so a previous model's level cannot stick.
  const thinkingLevel = clampCatalogThinkingLevel(
    form.thinkingLevel,
    compatible
      ? form.reasoning
        ? compatibleThinkingLevels(form.apiProtocol)
        : []
      : selected.thinkingLevels,
  ) as ThinkingLevel | null;
  const label = selected.providerName ?? selected.provider;
  if (compatible) {
    return {
      status: "ready",
      savingLimitOnly,
      activeModelId,
      input: {
        provider: selected.provider,
        baseUrl,
        apiProtocol: form.apiProtocol,
        headers: modelHeadersInput(form.headerRows),
        modelId,
        // The server adds the default itself.
        enabledModelIds: form.enabledModelIds.filter((id) => id !== modelId),
        reasoning: form.reasoning,
        thinkingLevel,
        maxTokens,
        contextWindow,
        supportsImages: form.supportsImages,
        maxImagesPerPrompt:
          form.supportsImages && !form.maxImagesPerPrompt.trim() ? null : maxImagesPerPrompt,
        ...(cacheCapabilitiesByModel ? { cacheCapabilitiesByModel } : {}),
        ...makeDefault,
        apiKey: form.apiKey.trim() || undefined,
        label,
        credentialId,
      },
    };
  }
  const modelChanged = (credential?.modelId ?? null) !== (activeModelId || null);
  const storedThinking =
    credential?.modelId === selected.id ? (credential.thinkingLevel ?? null) : null;
  return {
    status: "ready",
    savingLimitOnly,
    activeModelId,
    input: {
      provider: selected.provider,
      ...(newKey ? { apiKey: newKey } : {}),
      ...(selected.routingFields?.length
        ? { accountId: form.accountId.trim(), gatewayId: form.gatewayId.trim() }
        : {}),
      modelId: selected.id,
      // A limits-only save leaves the stored effort alone while the model and effort stay
      // put. Changing either sends the clamped level, including null, so the previous
      // model's effort is not reused.
      ...(!savingLimitOnly || modelChanged || (form.thinkingLevel ?? null) !== storedThinking
        ? { thinkingLevel }
        : {}),
      ...makeDefault,
      maxTokens: maxTokens ?? null,
      label,
      credentialId,
    },
  };
}
