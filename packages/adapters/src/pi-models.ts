import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { ModelOAuthSignInMode, ThinkingLevel } from "@rakazo/contracts";
import { LOCAL_PROVIDER_ID, registerLocalProvider } from "./pi-local-provider.js";
import { SUBSCRIPTION_SIGN_IN_PROVIDERS } from "./pi-oauth.js";
import {
  OPENAI_COMPATIBLE_CATALOG_MODEL_ID,
  OPENAI_COMPATIBLE_PROVIDER_ID,
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
};

export function listPiCatalog(): PiCatalogEntry[] {
  cachedCatalog ??= buildPiCatalog();
  return cachedCatalog;
}

let cachedCatalog: PiCatalogEntry[] | undefined;

function buildPiCatalog(): PiCatalogEntry[] {
  const models = registerOpenAiCompatibleCatalog(registerLocalProvider(builtinModels()));
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
        ...(model.id === OPENAI_COMPATIBLE_CATALOG_MODEL_ID ? { placeholder: true } : {}),
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
