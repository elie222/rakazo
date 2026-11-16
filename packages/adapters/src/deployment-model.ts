import { getEnvApiKey } from "@earendil-works/pi-ai/compat";
import type { ModelUsageLookup } from "@rakazo/adapter-kit";
import { modelProviderDefinition, modelProviders } from "./model-provider-registry.js";
import { OpenRouterUsageLookup } from "./openrouter-usage.js";
import { LOCAL_PROVIDER_ID, localModelIds } from "./pi-local-provider-id.js";

export const DEFAULT_OPENROUTER_MODEL_ID = modelProviders.openrouter.deployment.defaultModel;

/**
 * What Pi reports for a provider that authenticates from the host instead of a key: an AWS
 * profile or task role for Amazon Bedrock, Application Default Credentials for Vertex.
 */
const HOST_CREDENTIALS = "<authenticated>";

/** The kind of host credentials a provider authenticates with, e.g. "AWS IAM". */
export function hostCredentialSource(provider: string): string {
  return modelProviderDefinition(provider)?.hostCredentials?.source ?? "host";
}

/**
 * The deployment-wide model default: which provider a run falls back to when no user
 * credential applies, and the key for that provider.
 *
 * Keyless host authentication requires explicit opt-in and a model id. Bedrock resolves
 * its credential chain (including instance roles) at request time; local models must be
 * declared by the operator; the Claude Code CLI uses the operator's own sign-in on this host;
 * other providers must report host credentials in the process environment. Host credentials
 * never become `key`.
 *
 * Vendor env names and model ids live in the model provider registry, not in core.
 */
export function resolveDeploymentModel(env: NodeJS.ProcessEnv = process.env) {
  const provider = env.PI_DEFAULT_PROVIDER?.trim() || "openrouter";
  // An unknown provider gets no key rather than another vendor's.
  const deployment = modelProviderDefinition(provider)?.deployment;
  const explicitModel = env.PI_DEFAULT_MODEL?.trim();
  const key = deployment ? env[deployment.keyEnv] : undefined;
  const hostCredentials =
    !key &&
    Boolean(explicitModel) &&
    env.PI_DEFAULT_CREDENTIALS?.trim() === "host" &&
    (provider === LOCAL_PROVIDER_ID
      ? localModelIds(env).includes(explicitModel!)
      : modelProviderDefinition(provider)?.hostCredentials?.resolvedAtRequest ||
        getEnvApiKey(provider) === HOST_CREDENTIALS);
  return {
    provider,
    model: explicitModel || deployment?.defaultModel || DEFAULT_OPENROUTER_MODEL_ID,
    key,
    configured: Boolean(key) || hostCredentials,
    hostCredentials,
  };
}

export function deploymentModelUsageLookup(): ModelUsageLookup | undefined {
  const model = resolveDeploymentModel();
  return model.provider === "openrouter" && model.key
    ? new OpenRouterUsageLookup(model.key)
    : undefined;
}
