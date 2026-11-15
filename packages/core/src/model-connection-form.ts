import type {
  ModelApiProtocol,
  ModelCatalogEntry,
  ModelConnectInput,
  ModelCredential,
  ModelHeaderRow,
  SettingsScope,
  ThinkingLevel,
} from "@rakazo/contracts";
import {
  ModelHeaderRowsSchema,
  modelHeadersInput,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  openAiCompatibleConnectReady,
  savedCompatibleEndpointMatches,
} from "@rakazo/contracts";
import { clampCatalogThinkingLevel, pickCatalogModelId } from "./model-providers.js";

type CatalogModel = Pick<ModelCatalogEntry, "provider" | "id" | "recommended" | "thinkingLevels">;
type DefaultModel = { defaultProvider: string | null; defaultModel: string | null };

/** What a connection form edits, as the strings and toggles its fields hold. */
export type ConnectionFormFields = {
  enabledModelIds: string[];
  baseUrl: string;
  apiProtocol: ModelApiProtocol;
  thinkingLevel: ThinkingLevel | null;
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
  credential?: Pick<
    ModelCredential,
    | "modelId"
    | "enabledModelIds"
    | "baseUrl"
    | "apiProtocol"
    | "thinkingLevel"
    | "accountId"
    | "gatewayId"
  >;
  /** Prefills a new OpenAI-compatible connection, such as a hosted preset. */
  presetBaseUrl?: string;
}): ConnectionFormFields {
  const { catalog, provider, modelId, credential, presetBaseUrl } = input;
  const compatible = provider === OPENAI_COMPATIBLE_PROVIDER_ID;
  return {
    enabledModelIds: credential?.enabledModelIds ?? [],
    baseUrl: compatible ? (credential?.baseUrl ?? presetBaseUrl ?? "") : "",
    apiProtocol: credential?.apiProtocol ?? "chat-completions",
    // An OpenAI-compatible model's effort is chosen where its model is used.
    thinkingLevel: compatible
      ? null
      : (clampCatalogThinkingLevel(
          credential?.modelId === modelId ? credential.thinkingLevel : null,
          catalog.find((entry) => entry.provider === provider && entry.id === modelId)
            ?.thinkingLevels,
        ) as ThinkingLevel | null),
    accountId: credential?.accountId ?? "",
    gatewayId: credential?.gatewayId ?? "",
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

export type ModelConnectRequest =
  | { status: "incomplete" }
  | {
      status: "ready";
      input: ModelConnectInput;
      /** A catalog provider's save without a new key: gateway ids only. */
      savingWithoutKey: boolean;
      /** The model the saved connection runs. */
      activeModelId: string;
    };

/**
 * The `models.connect` input for a connection form. `settingsOnly` saves a catalog provider's
 * gateway ids without the key field. `makeDefault` is sent with its scope when set.
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
}): ModelConnectRequest {
  const { form, selected, credential, credentialId, settingsOnly = false, makeDefault } = input;
  const compatible = selected.provider === OPENAI_COMPATIBLE_PROVIDER_ID;
  const baseUrl = form.baseUrl.trim();
  const modelId = form.modelId.trim();
  const newKey = settingsOnly ? "" : form.apiKey.trim();
  const savingWithoutKey = !compatible && !newKey;
  const activeModelId = compatible ? modelId : selected.id;
  if (compatible) {
    if (!baseUrl || !modelId) return { status: "incomplete" };
  } else if (savingWithoutKey) {
    if (!credential) return { status: "incomplete" };
  } else if (newKey.length < 8) {
    return { status: "incomplete" };
  }
  // The staged effort belongs to the model on screen. Clamp it before a save so a previous
  // model's level cannot stick.
  const thinkingLevel = clampCatalogThinkingLevel(
    form.thinkingLevel,
    selected.thinkingLevels,
  ) as ThinkingLevel | null;
  const label = selected.providerName ?? selected.provider;
  if (compatible) {
    return {
      status: "ready",
      savingWithoutKey,
      activeModelId,
      input: {
        provider: selected.provider,
        baseUrl,
        apiProtocol: form.apiProtocol,
        headers: modelHeadersInput(form.headerRows),
        modelId,
        // The server adds the default itself.
        enabledModelIds: form.enabledModelIds.filter((id) => id !== modelId),
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
    savingWithoutKey,
    activeModelId,
    input: {
      provider: selected.provider,
      ...(newKey ? { apiKey: newKey } : {}),
      ...(selected.routingFields?.length
        ? { accountId: form.accountId.trim(), gatewayId: form.gatewayId.trim() }
        : {}),
      modelId: selected.id,
      // A save without a key leaves the stored effort alone while the model and effort stay
      // put. Changing either sends the clamped level, including null, so the previous
      // model's effort is not reused.
      ...(!savingWithoutKey || modelChanged || (form.thinkingLevel ?? null) !== storedThinking
        ? { thinkingLevel }
        : {}),
      ...makeDefault,
      label,
      credentialId,
    },
  };
}
