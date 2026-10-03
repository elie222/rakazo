import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { ModelOAuthSignInMode, ThinkingLevel } from "@rakazo/contracts";
import { supplementPiModels } from "./pi-current-models.js";
import { LOCAL_PROVIDER_ID, registerLocalProvider } from "./pi-local-provider.js";
import { SUBSCRIPTION_SIGN_IN_PROVIDERS } from "./pi-oauth.js";
import {
  OPENAI_COMPATIBLE_PROVIDER_ID,
  probeOpenAiCompatibleModels,
  registerOpenAiCompatibleCatalog,
} from "./pi-openai-compatible-provider.js";

export type PiCatalogAuth = "api-key" | "oauth" | "both";

export type PiCatalogEntry = {
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
  placeholder?: boolean;
  /** Provider models share one pinned HTTPS models-list base URL. */
  catalogProbe?: boolean;
};

const catalogProbeBaseUrls = new Map<string, string>();

/** Pinned models-list URL for a catalog provider, taken from the model registry. */
export function catalogProviderProbeBaseUrl(provider: string): string | null {
  listPiCatalog();
  return catalogProbeBaseUrls.get(provider) ?? null;
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
  if (!baseUrl) throw new Error("This provider cannot be tested without saving.");
  return probeOpenAiCompatibleModels({ baseUrl, apiKey: input.apiKey }, fetchImpl, signal, {
    allowPublic: true,
    catalogProbe: true,
  });
}

/** Wire protocols whose registry base URL also serves GET {base}/models. */
const CATALOG_PROBE_APIS = new Set(["openai-completions", "openai-responses"]);

function pinnedOpenAiCompletionsBaseUrl(
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
  const models = registerOpenAiCompatibleCatalog(
    registerLocalProvider(supplementPiModels(builtinModels())),
  );
  const entries: PiCatalogEntry[] = [];
  for (const provider of models.getProviders()) {
    const apiKey = Boolean(provider.auth.apiKey);
    const oauth = Boolean(provider.auth.oauth);
    const auth: PiCatalogAuth = apiKey && oauth ? "both" : oauth ? "oauth" : "api-key";
    const signInMeta = SUBSCRIPTION_SIGN_IN_PROVIDERS[provider.id];
    const oauthLabel =
      signInMeta?.loginLabel ?? provider.auth.oauth?.loginLabel ?? provider.auth.oauth?.name;
    const subscription = Boolean(provider.auth.oauth?.isSubscription);
    const billing = catalogBilling(provider.id, provider.name, {
      apiKey,
      oauth,
    });
    const providerModels = provider.getModels();
    const probeBaseUrl = pinnedOpenAiCompletionsBaseUrl(provider.id, providerModels);
    if (probeBaseUrl) catalogProbeBaseUrls.set(provider.id, probeBaseUrl);
    const modelIds = providerModels.map((model) => model.id);
    for (const model of providerModels) {
      const thinkingLevels = getSupportedThinkingLevels(model) as ThinkingLevel[];
      entries.push({
        provider: provider.id,
        providerName: provider.name,
        id: model.id,
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
        ...(provider.id === OPENAI_COMPATIBLE_PROVIDER_ID ? { placeholder: true } : {}),
        ...(probeBaseUrl ? { catalogProbe: true } : {}),
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
const LATEST_MARKER = /[\s(/-]*\blatest\b\s*\)?\s*(\([^)]*\)\s*)?$/i;

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
  if (!LATEST_MARKER.test(label)) return label;
  const base = label.replace(LATEST_MARKER, "").trim();
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
  const signInMeta = SUBSCRIPTION_SIGN_IN_PROVIDERS[providerId];
  if (signInMeta) return signInMeta.billing;
  if (providerId === LOCAL_PROVIDER_ID) {
    return "Runs on infrastructure configured by the deployment owner. No model charges from Rakazo.";
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
