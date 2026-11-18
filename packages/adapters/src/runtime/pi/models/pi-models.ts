import type { Api, Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type {
  CompatibleEndpointPreset,
  ModelOAuthSignInMode,
  ModelRoutingField,
  ThinkingLevel,
} from "@rakazo/contracts";
import {
  assertHeaderSafeApiKey,
  ConnectionSetupError,
  canonicalPiProviderId,
  MODEL_KEY_REJECTED_ERROR,
  trimEndChars,
} from "@rakazo/contracts";
import {
  approvedModelCreditOffering,
  modelCreditOfferings,
} from "../../../model-credits/offerings.js";
import { cloudflareRoutingFields } from "../../../models/endpoints/cloudflare-ai-gateway.js";
import { COMPATIBLE_ENDPOINT_PRESETS } from "../../../models/endpoints/openai-compatible-url.js";
import { modelProviderDefinition } from "../../../models/model-provider-registry.js";
import { MODEL_CONNECT_TIMEOUT_MS } from "../pi-runtime-limits.js";
import { maximumModelCallCost } from "../usage/pi-usage.js";
import { LOCAL_PROVIDER_ID, registerLocalProvider } from "./pi-local-provider.js";
import { applyPiModelCompatibility } from "./pi-model-compat.js";
import { loadProviderOAuth } from "./pi-oauth.js";
import {
  OPENAI_COMPATIBLE_PROVIDER_ID,
  probeOpenAiCompatibleModels,
  registerOpenAiCompatibleCatalog,
} from "./pi-openai-compatible-provider.js";

export type PiCatalogAuth = "api-key" | "oauth" | "both";

export type PiCatalogEntry = {
  recommended?: boolean;
  provider: string;
  providerName: string;
  id: string;
  label: string;
  billing: string;
  auth: PiCatalogAuth;
  oauthLabel?: string;
  authHint?: string;
  subscription: boolean;
  signIn?: ModelOAuthSignInMode;
  reasoning?: boolean;
  thinkingLevels?: ThinkingLevel[];
  defaultCapabilities?: { images?: boolean; reasoning?: boolean; thinkingLevels?: ThinkingLevel[] };
  /** The model reads images. Left out where a connection setting decides it. */
  images?: boolean;
  /** The model card's context window and output ceiling. */
  contextWindow?: number;
  maxTokens?: number;
  placeholder?: boolean;
  /** Provider models share one pinned HTTPS models-list base URL. */
  catalogProbe?: boolean;
  routingFields?: ModelRoutingField[];
  endpointPresets?: CompatibleEndpointPreset[];
  live?: true;
};

export function isRecommendedCatalogModel(provider: string, id: string): boolean {
  return modelProviderDefinition(canonicalPiProviderId(provider))?.recommendedModel === id;
}

/**
 * Whether an agent run can use this model. Pickers leave the rest out so a new user cannot
 * choose a model whose every run fails; saved choices keep working and stay visible.
 */
export function catalogModelServesAgents(
  model: Pick<Model<Api>, "provider" | "id"> & {
    cost?: Pick<Model<Api>["cost"], "input" | "output">;
  },
): boolean {
  const provider = canonicalPiProviderId(model.provider);
  // OpenRouter's `:batch` variants only exist on its batch endpoint, never on chat completions.
  if (model.id.endsWith(":batch")) return false;
  // OpenCode's free tier only answers its own app; the registry prices those models at zero.
  if (provider === "opencode" && model.cost?.input === 0 && model.cost.output === 0) return false;
  return !modelProviderDefinition(provider)?.unservedModels?.includes(model.id);
}

/** Drop models agents cannot run, keeping any `provider:id` the account has already saved. */
export function offeredCatalog<T extends { provider: string; id: string }>(
  entries: readonly T[],
  saved: ReadonlySet<string> = new Set(),
): T[] {
  return entries.filter(
    (entry) => !hiddenCatalogModel(entry) || saved.has(`${entry.provider}:${entry.id}`),
  );
}

/** A bundled model priced in the registry, or a live id judged by its id alone. */
export function hiddenCatalogModel(entry: { provider: string; id: string }): boolean {
  listPiCatalog();
  const key = `${canonicalPiProviderId(entry.provider)}:${entry.id}`;
  return hiddenCatalogKeys.has(key) || !catalogModelServesAgents(entry);
}

const hiddenCatalogKeys = new Set<string>();
const pricedCatalogKeys = new Set<string>();

/** Rakazo credits reserve a call's price before sending it, so they only run a model with one. */
export function creditsCanPriceModel(entry: { provider: string; id: string }): boolean {
  if (modelCreditOfferings()) return Boolean(approvedModelCreditOffering(entry.provider, entry.id));
  listPiCatalog();
  return pricedCatalogKeys.has(`${canonicalPiProviderId(entry.provider)}:${entry.id}`);
}

const catalogProbeBaseUrls = new Map<string, string>();
const catalogBaseUrls = new Map<string, Set<string>>();

const trimBaseUrl = (url: string) => trimEndChars(url.trim(), "/");

/** Whether `url` is one the model registry itself uses for this catalog provider. */
export function isCatalogProviderBaseUrl(provider: string, url: string): boolean {
  listPiCatalog();
  return catalogBaseUrls.get(canonicalPiProviderId(provider))?.has(trimBaseUrl(url)) ?? false;
}

/** Pinned models-list URL for a catalog provider, taken from the model registry. */
export function catalogProviderProbeBaseUrl(provider: string): string | null {
  listPiCatalog();
  return catalogProbeBaseUrls.get(canonicalPiProviderId(provider)) ?? null;
}

const KEY_CHECK_CANCELLED = "Could not verify the API key. Try again.";

/** Refuses only a key the provider rejects; a slow or failing provider is no reason to block saving it. */
export async function verifyCatalogProviderApiKey(
  input: { provider: string; apiKey: string },
  fetchImpl: typeof fetch = globalThis.fetch,
  signal?: AbortSignal,
): Promise<void> {
  assertHeaderSafeApiKey(input.apiKey.trim());
  const provider = canonicalPiProviderId(input.provider);
  // Public catalogs cannot establish key validity, so only a provider's own check can.
  const check = modelProviderDefinition(provider)?.keyCheck;
  if (!check) return;
  let response: Response;
  try {
    response = await fetchImpl(check.url, {
      headers: check.headers(input.apiKey.trim()),
      redirect: "error",
      signal: AbortSignal.any([
        AbortSignal.timeout(MODEL_CONNECT_TIMEOUT_MS),
        ...(signal ? [signal] : []),
      ]),
    });
  } catch {
    // Transport errors may contain the request's credential. Never forward them.
    if (signal?.aborted) throw new ConnectionSetupError(KEY_CHECK_CANCELLED);
    return;
  }
  const rejected = await check.rejected(response);
  void response.body?.cancel().catch(() => undefined);
  if (rejected) {
    throw new ConnectionSetupError(MODEL_KEY_REJECTED_ERROR);
  }
  if (signal?.aborted) throw new ConnectionSetupError(KEY_CHECK_CANCELLED);
}

/**
 * List models for a catalog provider whose registry base URL is pinned.
 * Caller-supplied URLs stay on `probeOpenAiCompatibleModels`, which still
 * rejects public hosts unless the deployment opens that gate.
 */
export async function probeCatalogProviderModels(
  input: { provider: string; apiKey: string },
  fetchImpl?: typeof fetch,
  signal?: AbortSignal,
): Promise<string[]> {
  const baseUrl = catalogProviderProbeBaseUrl(input.provider);
  if (!baseUrl) throw new ConnectionSetupError("This provider cannot be tested without saving.");
  await verifyCatalogProviderApiKey(input, fetchImpl, signal);
  return probeOpenAiCompatibleModels({ baseUrl, apiKey: input.apiKey }, fetchImpl, signal, {
    allowPublic: true,
    catalogProbe: true,
  });
}

/** Wire protocols whose registry base URL also serves GET {base}/models. */
const CATALOG_PROBE_APIS = new Set(["openai-completions", "openai-responses"]);

function pinnedCatalogProbeBaseUrl(
  providerId: string,
  models: ReadonlyArray<{ api: string; baseUrl?: string }>,
): string | null {
  if (providerId === OPENAI_COMPATIBLE_PROVIDER_ID || providerId === LOCAL_PROVIDER_ID) {
    return null;
  }
  const urls = new Set<string>();
  for (const model of models) {
    if (!CATALOG_PROBE_APIS.has(model.api) || !model.baseUrl) continue;
    const trimmed = model.baseUrl.replace(/\/+$/, "");
    // Account-scoped templates such as {CLOUDFLARE_ACCOUNT_ID} are not probe URLs.
    if (trimmed.includes("{") || trimmed.includes("}")) return null;
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return null;
    }
    if (url.protocol !== "https:" || url.username || url.password) return null;
    urls.add(trimmed);
  }
  if (urls.size !== 1) return null;
  return [...urls][0] ?? null;
}

export function listPiCatalog(): PiCatalogEntry[] {
  cachedCatalog ??= buildPiCatalog();
  return cachedCatalog;
}

let cachedCatalog: PiCatalogEntry[] | undefined;

function buildPiCatalog(): PiCatalogEntry[] {
  catalogProbeBaseUrls.clear();
  catalogBaseUrls.clear();
  hiddenCatalogKeys.clear();
  pricedCatalogKeys.clear();
  const models = registerOpenAiCompatibleCatalog(
    registerLocalProvider(applyPiModelCompatibility(builtinModels())),
  );
  const entries: PiCatalogEntry[] = [];
  for (const provider of models.getProviders()) {
    const definition = modelProviderDefinition(provider.id);
    const providerName = definition?.displayName ?? provider.name;
    const apiKey = Boolean(provider.auth.apiKey);
    const oauthAuth = loadProviderOAuth(provider.id);
    const oauth = Boolean(oauthAuth);
    const auth: PiCatalogAuth = apiKey && oauth ? "both" : oauth ? "oauth" : "api-key";
    const signInMeta = definition?.signIn;
    const oauthLabel = signInMeta?.loginLabel ?? oauthAuth?.loginLabel ?? oauthAuth?.name;
    const subscription = Boolean(oauthAuth?.isSubscription);
    const billing = catalogBilling(provider.id, providerName, {
      apiKey,
      oauth,
    });
    const providerModels = provider.getModels();
    const probeBaseUrl = pinnedCatalogProbeBaseUrl(provider.id, providerModels);
    if (probeBaseUrl) catalogProbeBaseUrls.set(provider.id, probeBaseUrl);
    catalogBaseUrls.set(
      provider.id,
      new Set(
        providerModels.flatMap((model) => (model.baseUrl ? [trimBaseUrl(model.baseUrl)] : [])),
      ),
    );
    const modelIds = providerModels.map((model) => model.id);
    const routingFields = definition?.routingFields ?? cloudflareRoutingFields(provider.id);
    for (const model of providerModels) {
      if (!catalogModelServesAgents(model)) hiddenCatalogKeys.add(`${provider.id}:${model.id}`);
      if (maximumModelCallCost(model.cost, 0, 0) !== undefined)
        pricedCatalogKeys.add(`${provider.id}:${model.id}`);
      const thinkingLevels = getSupportedThinkingLevels(model) as ThinkingLevel[];
      entries.push({
        provider: provider.id,
        providerName,
        id: model.id,
        recommended: isRecommendedCatalogModel(provider.id, model.id),
        label: catalogModelLabel(model.id, model.name, modelIds),
        billing,
        auth,
        oauthLabel,
        authHint:
          provider.id === OPENAI_COMPATIBLE_PROVIDER_ID ? "Custom server" : signInMeta?.hint,
        subscription,
        signIn: signInMeta?.mode,
        reasoning: Boolean(model.reasoning),
        thinkingLevels,
        // Compatibility metadata does not prove a model is served by a user's
        // endpoint. Keep each custom connection scoped to its entered model ID.
        // Its image support is the connection's own setting, not the catalog's.
        ...(provider.id === OPENAI_COMPATIBLE_PROVIDER_ID
          ? { placeholder: true, endpointPresets: COMPATIBLE_ENDPOINT_PRESETS }
          : {
              images: model.input.includes("image"),
              contextWindow: model.contextWindow,
              maxTokens: model.maxTokens,
            }),
        ...(probeBaseUrl ? { catalogProbe: true } : {}),
        ...(routingFields ? { routingFields } : {}),
      });
    }
  }

  const envDefaultModel = process.env.PI_DEFAULT_MODEL?.trim();
  const envDefaultProvider = process.env.PI_DEFAULT_PROVIDER?.trim() || "openrouter";
  if (
    envDefaultProvider === "openrouter" &&
    envDefaultModel &&
    !models.getModel("openrouter", envDefaultModel)
  ) {
    entries.unshift({
      provider: "openrouter",
      providerName: "OpenRouter",
      id: envDefaultModel,
      label: catalogModelLabel(envDefaultModel),
      billing: `Configured via PI_DEFAULT_MODEL (${envDefaultModel}).`,
      auth: "api-key",
      subscription: false,
      reasoning: true,
      thinkingLevels: ["off", "minimal", "low", "medium", "high"],
      ...(catalogProbeBaseUrls.has("openrouter") ? { catalogProbe: true } : {}),
    });
  }

  return entries;
}

/**
 * Trailing upstream "latest" marker: "Claude Opus 4.5 (latest)", "Gemini Flash Latest",
 * "foo-latest", or an alias parenthetical like "Qwen Max Latest (Qwen3.8 Max)".
 */
const LATEST_MARKER = /\blatest\b\s*(?:\)\s*)?(?:\([^)]*\)\s*)?$/i;

/** Where the marker starts, with the spaces, brackets and dashes before it, or -1. */
function latestMarkerStart(label: string): number {
  const match = LATEST_MARKER.exec(label);
  if (!match) return -1;
  let start = match.index;
  while (start > 0 && /[\s(/-]/.test(label[start - 1]!)) start--;
  return start;
}

/**
 * Upstream marks auto-updating alias ids with a trailing "latest". That is an alias marker, not a
 * recency claim, so it lands on families like Claude Opus 4.5 while the actually newest models
 * (Claude Opus 5, Claude Fable 5) carry no marker at all. Read straight off a picker it says the
 * opposite of the truth, so state what the id really does instead.
 */
export function catalogModelLabel(
  id: string,
  name?: string,
  providerModelIds: readonly string[] = [],
): string {
  const label = name || id;
  const marker = latestMarkerStart(label);
  if (marker < 0) return label;
  const base = label.slice(0, marker).trim();
  if (!base) return label;
  return isAliasModelId(id, providerModelIds) ? `${base} (auto-updates)` : base;
}

/**
 * An alias id either ends in `latest` or is the undated prefix of a dated sibling. The suffix has
 * to be a bare date of 4-8 digits (`-2508`, `-260401`, `-20251001`). A variant like `-preview` or
 * `-fast` is its own pinned model, not a snapshot of this one.
 */
function isAliasModelId(id: string, providerModelIds: readonly string[]): boolean {
  if (/[-/]latest$/i.test(id)) return true;
  return providerModelIds.some(
    (other) => other.startsWith(`${id}-`) && /^\d{4,8}$/.test(other.slice(id.length + 1)),
  );
}

function catalogBilling(
  providerId: string,
  name: string,
  opts: { apiKey: boolean; oauth: boolean },
) {
  const signInMeta = modelProviderDefinition(providerId)?.signIn;
  if (signInMeta) return signInMeta.billing;
  if (providerId === LOCAL_PROVIDER_ID) {
    return "Runs on infrastructure configured by the server operator. No model charges from Rakazo.";
  }
  if (providerId === OPENAI_COMPATIBLE_PROVIDER_ID) {
    return "Runs on a URL you control. Rakazo does not pay for model usage.";
  }
  if (opts.oauth && !opts.apiKey) {
    return `${name} subscription login is not in the Rakazo UI yet. Skip if this deployment already has credentials.`;
  }
  if (opts.apiKey) {
    return `Uses your ${name} API key. Rakazo does not pay for model usage.`;
  }
  return `Uses your ${name} key. Rakazo does not pay for model usage.`;
}

export const scriptedCatalogEntry: PiCatalogEntry = {
  provider: "scripted",
  providerName: "Scripted",
  id: "scripted",
  label: "Scripted runtime (local verification)",
  billing: "No model charges. Deterministic fixture for tests.",
  auth: "api-key",
  subscription: false,
};
