import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { LOCAL_PROVIDER_IDS, withLocalProviders } from "./local-providers.js";
import { DEVICE_CODE_PROVIDERS, DEVICE_CODE_SIGN_IN, isDeviceCodeProvider } from "./pi-oauth.js";

export type PiCatalogAuth = "api-key" | "oauth" | "both";
export type PiCatalogSignIn = typeof DEVICE_CODE_SIGN_IN;

export type PiCatalogEntry = {
  provider: string;
  providerName: string;
  id: string;
  label: string;
  billing: string;
  auth: PiCatalogAuth;
  oauthLabel?: string;
  subscription: boolean;
  signIn?: PiCatalogSignIn;
  /** True for local providers that take no API key (Ollama, Local MLX server). */
  keyless?: boolean;
};

export function listPiCatalog(): PiCatalogEntry[] {
  cachedCatalog ??= buildPiCatalog();
  return cachedCatalog;
}

let cachedCatalog: PiCatalogEntry[] | undefined;

function buildPiCatalog(): PiCatalogEntry[] {
  const models = withLocalProviders(builtinModels());
  const entries: PiCatalogEntry[] = [];
  for (const provider of models.getProviders()) {
    const apiKey = Boolean(provider.auth.apiKey);
    const oauth = Boolean(provider.auth.oauth);
    const auth: PiCatalogAuth = apiKey && oauth ? "both" : oauth ? "oauth" : "api-key";
    const device = DEVICE_CODE_PROVIDERS[provider.id];
    const oauthLabel =
      device?.loginLabel ?? provider.auth.oauth?.loginLabel ?? provider.auth.oauth?.name;
    const subscription = Boolean(provider.auth.oauth?.isSubscription);
    const signIn = isDeviceCodeProvider(provider.id) ? DEVICE_CODE_SIGN_IN : undefined;
    const billing = catalogBilling(provider.id, provider.name, {
      apiKey,
      oauth,
    });
    const keyless = LOCAL_PROVIDER_IDS.has(provider.id);
    for (const model of provider.getModels()) {
      entries.push({
        provider: provider.id,
        providerName: provider.name,
        id: model.id,
        label: model.name || model.id,
        billing,
        auth,
        oauthLabel,
        subscription,
        signIn,
        keyless,
      });
    }
  }
  return entries;
}

function catalogBilling(
  providerId: string,
  name: string,
  opts: { apiKey: boolean; oauth: boolean },
) {
  const device = DEVICE_CODE_PROVIDERS[providerId];
  if (device) return device.billing;
  if (LOCAL_PROVIDER_IDS.has(providerId)) {
    return `Runs on your own machine via ${name}. No API key, no network egress, no cost.`;
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
