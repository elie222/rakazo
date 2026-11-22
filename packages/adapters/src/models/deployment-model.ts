import { getEnvApiKey } from "@earendil-works/pi-ai/compat";
import type { ModelUsageLookup, SecretStore } from "@rakazo/adapter-kit";
import { canonicalPiProviderId, OPENAI_COMPATIBLE_PROVIDER_ID } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { modelCreditOfferings } from "../model-credits/offerings.js";
import { LOCAL_PROVIDER_ID, localModelIds } from "../runtime/pi/models/pi-local-provider-id.js";
import { hiddenCatalogModel, listPiCatalog } from "../runtime/pi/models/pi-models.js";

import { modelProviderAllowed, modelProviderAllowlist } from "./model-provider-allowlist.js";
import { modelProviderDefinition, modelProviders } from "./model-provider-registry.js";
import { parseModelSecret } from "./model-secret.js";

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
  const offerings = modelCreditOfferings(env);
  if (offerings) {
    const selected = offerings.offerings.find((entry) => entry.id === offerings.defaultOfferingId);
    return {
      provider: selected?.provider ?? "",
      model: selected?.modelId ?? "",
      key: undefined,
      configured: Boolean(selected),
      hostCredentials: false,
    };
  }
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
  return model.key ? modelProviderDefinition(model.provider)?.usageLookup?.(model.key) : undefined;
}

/** Record id binding the key an admin saved for everyone to the deployment's settings row. */
export const DEPLOYMENT_MODEL_RECORD = "deployment-model";

/** The deployment settings row's fields that hold an admin's default model for everyone. */
export type SavedDeploymentModel = {
  defaultModelProvider: string | null;
  defaultModelId: string | null;
  deploymentModelCredentialCipher?: string | null;
  modelCreditsEnabled?: boolean;
};

/**
 * The model and key an admin connected for everyone, while they apply. Model credits always run
 * on the operator's own connection, so a saved one is never used on a credits deployment, and the
 * provider allowlist governs it like any connection an app account makes.
 */
export function adminDeploymentModel(
  settings: SavedDeploymentModel | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { provider: string; modelId: string; cipher: string } | null {
  const provider = settings?.defaultModelProvider?.trim();
  const modelId = settings?.defaultModelId?.trim();
  const cipher = settings?.deploymentModelCredentialCipher;
  if (!provider || !modelId || !cipher) return null;
  if (settings.modelCreditsEnabled || modelCreditOfferings(env)) return null;
  if (!modelProviderAllowed(modelProviderAllowlist(), provider)) return null;
  return { provider, modelId, cipher };
}

/**
 * The key that serves a provider for a member without a connection of their own: the admin's for
 * the provider they connected, else the environment's for its provider. Never another vendor's.
 */
export async function deploymentModelKey(
  deps: {
    prisma: Pick<PrismaClient, "deploymentSettings">;
    secretStore: Pick<SecretStore, "load">;
  },
  provider: string,
  environment: {
    provider: string;
    key: string | undefined;
    /** Credit-funded and operator-paid calls use the operator's own key, never an admin's. */
    operatorOnly?: boolean;
  },
): Promise<string | undefined> {
  const saved = environment.operatorOnly
    ? null
    : adminDeploymentModel(
        await deps.prisma.deploymentSettings.findUnique({
          where: { id: "default" },
          select: {
            defaultModelProvider: true,
            defaultModelId: true,
            deploymentModelCredentialCipher: true,
            modelCreditsEnabled: true,
          },
        }),
      );
  if (saved && canonicalPiProviderId(saved.provider) === canonicalPiProviderId(provider)) {
    const secret = parseModelSecret(
      await deps.secretStore.load(saved.cipher, DEPLOYMENT_MODEL_RECORD),
    );
    return secret.kind === "api_key" ? secret.key : undefined;
  }
  return environment.key && provider === environment.provider ? environment.key : undefined;
}

/**
 * Providers an admin can connect for everyone with a key alone, and the models each runs. Ones
 * that need routing ids, a sign-in or an endpoint stay operator configuration.
 */
export function deploymentModelProviders(): {
  id: string;
  name: string;
  models: { id: string; label: string }[];
}[] {
  const providers = new Map<
    string,
    { id: string; name: string; models: { id: string; label: string }[] }
  >();
  for (const entry of listPiCatalog()) {
    if (
      entry.placeholder ||
      entry.endpointPresets ||
      entry.routingFields?.length ||
      (entry.auth !== "api-key" && entry.auth !== "both") ||
      entry.provider === LOCAL_PROVIDER_ID ||
      entry.provider === OPENAI_COMPATIBLE_PROVIDER_ID ||
      hiddenCatalogModel(entry)
    )
      continue;
    const provider = providers.get(entry.provider) ?? {
      id: entry.provider,
      name: entry.providerName ?? entry.provider,
      models: [],
    };
    provider.models.push({ id: entry.id, label: entry.label });
    providers.set(entry.provider, provider);
  }
  return [...providers.values()];
}
