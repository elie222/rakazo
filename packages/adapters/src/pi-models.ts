import { createProvider, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { Api, Model, MutableModels, ProviderStreams } from "@earendil-works/pi-ai";
import type { ModelOAuthSignInMode, ThinkingLevel } from "@rakazo/contracts";
import { LOCAL_PROVIDER_ID, registerLocalProvider } from "./pi-local-provider.js";
import { SUBSCRIPTION_SIGN_IN_PROVIDERS } from "./pi-oauth.js";
import {
  OPENAI_COMPATIBLE_PROVIDER_ID,
  registerOpenAiCompatibleCatalog,
} from "./pi-openai-compatible-provider.js";
import { workmateClaudeProvider } from "./workmate-claude.js";

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
};

export function listPiCatalog(): PiCatalogEntry[] {
  cachedCatalog ??= buildPiCatalog();
  return cachedCatalog;
}

let cachedCatalog: PiCatalogEntry[] | undefined;

const ASTRA_MODEL_ID = "gpt-6-astra";
const ASTRA_CONTEXT_WINDOW = 272_000;
// Pi requires an output cap, but Codex's first-party registry does not publish Astra's.
// This is a conservative adapter safety cap, not a claim about the provider limit.
const ASTRA_ADAPTER_MAX_TOKENS = 32_768;
const ASTRA_THINKING_LEVELS: ThinkingLevel[] = ["low", "medium", "high", "xhigh", "max", "ultra"];

/** Add the currently supported Codex model to older Pi catalogs while retaining the real stream. */
export function registerAstraModel(models: MutableModels): MutableModels {
  const provider = models.getProvider("openai-codex");
  if (!provider || provider.getModels().some((model) => model.id === ASTRA_MODEL_ID)) return models;
  const modelBaseUrl = provider.baseUrl ?? provider.getModels()[0]?.baseUrl;
  if (!modelBaseUrl) return models;
  const astra: Model<"openai-codex-responses"> = {
    id: ASTRA_MODEL_ID,
    name: "GPT-6 Astra",
    api: "openai-codex-responses",
    provider: "openai-codex",
    baseUrl: modelBaseUrl,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: ASTRA_CONTEXT_WINDOW,
    maxTokens: ASTRA_ADAPTER_MAX_TOKENS,
    thinkingLevelMap: {
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
      ultra: "ultra",
    } as Model<"openai-codex-responses">["thinkingLevelMap"] & { ultra: "ultra" },
  };
  const api: ProviderStreams = {
    stream: (model, context, options) => provider.stream(model, context, options),
    streamSimple: (model, context, options) =>
      model.provider === "openai-codex" &&
      model.id === ASTRA_MODEL_ID &&
      (options as { reasoning?: string } | undefined)?.reasoning === "ultra"
        ? provider.stream(model, context, {
            ...options,
            reasoningEffort: "ultra",
          } as never)
        : provider.streamSimple(model, context, options),
  };
  models.setProvider(
    createProvider({
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      headers: provider.headers,
      auth: provider.auth,
      models: [...provider.getModels(), astra] as readonly Model<Api>[],
      filterModels: provider.filterModels?.bind(provider),
      api,
    }),
  );
  return models;
}

function buildPiCatalog(): PiCatalogEntry[] {
  const models = registerAstraModel(
    registerOpenAiCompatibleCatalog(registerLocalProvider(builtinModels())),
  );
  const workmateClaude = workmateClaudeProvider();
  if (workmateClaude) models.setProvider(workmateClaude);
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
    const modelIds = providerModels.map((model) => model.id);
    for (const model of providerModels) {
      const thinkingLevels =
        provider.id === "openai-codex" && model.id === ASTRA_MODEL_ID
          ? ASTRA_THINKING_LEVELS
          : (getSupportedThinkingLevels(model) as ThinkingLevel[]);
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
    });
  }

  return entries;
}

/** Trailing upstream "latest" marker: "Claude Opus 4.5 (latest)", "Gemini Flash Latest", "foo-latest". */
const LATEST_MARKER = /[\s(/-]*\blatest\b\s*\)?\s*$/i;

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
