/**
 * Deployment models: the model connections a deployment owns, its default model, and which
 * of their models members may run without a connection of their own.
 *
 * - Connections come from the environment (OPENROUTER_API_KEY, ANTHROPIC_API_KEY,
 *   DEEPSEEK_API_KEY; the RAKAZO_LOCAL_MODELS server; host credentials for PI_DEFAULT_PROVIDER
 *   with PI_DEFAULT_CREDENTIALS=host) and from admins in Settings (`deployment_model_connections`,
 *   one per provider: a catalog provider's API key, or an OpenAI-compatible endpoint stored like
 *   a member's, all encrypted). An admin's replaces the environment's for the same provider.
 * - The default model is PI_DEFAULT_PROVIDER/PI_DEFAULT_MODEL, or an admin's choice
 *   (`deployment_settings.defaultModelProvider`/`defaultModelId`). Members who chose nothing
 *   run on it.
 * - Other models members may use: PI_DEPLOYMENT_MODELS, or an admin's list
 *   (`deployment_settings.allowedModels`; null follows the environment). Comma-separated
 *   `provider:model`, `provider:*`, or `*` for every model of every deployment connection (a
 *   catalog provider's catalog models; the local server's or an endpoint's listed ids). Empty
 *   serves only the default model, as before this list existed.
 *
 * Contract for model pickers: catalog entries from `models.list` and `models.forRole` that the
 * deployment serves to this member carry `managed: true` ("available through the deployment
 * without a personal credential"), the field hosted credits already set, and
 * `connectedModelChoices` in @rakazo/core already offers them. Bot, routine and model-role
 * validation accept them without a connection (except the computer-use role, which runs on the
 * member's own connections only). A member's own connection for the provider wins: the entry is
 * then not marked, and runs use (and bill) the member's key. Served models a catalog does not
 * list (an endpoint's) are added to `models.list` as entries with `label` = id. Admins edit all of
 * this through `models.deployment.get/update/connect/disconnect/probe`, which never return keys.
 */
import { getEnvApiKey } from "@earendil-works/pi-ai/compat";
import type { ModelUsageLookup, SecretStore } from "@rakazo/adapter-kit";
import {
  canonicalPiProviderId,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  usableModelId,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";
import type { StoredModelSecret } from "./model-secret.js";
import { parseModelSecret } from "./model-secret.js";
import { OpenRouterUsageLookup } from "./openrouter-usage.js";
import { LOCAL_PROVIDER_ID, localModelIds } from "./pi-local-provider-id.js";
import { listPiCatalog, offeredCatalog } from "./pi-models.js";

export const DEFAULT_OPENROUTER_MODEL_ID = "anthropic/claude-haiku-5.5";

/** Providers a deployment runs on its own key, with the environment variable that holds it. */
const DEPLOYMENT_KEY_ENV: Record<string, string> = {
  openrouter: "OPENROUTER_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
};

/** Each keyed provider's model when none is named. */
const DEPLOYMENT_DEFAULT_MODELS: Record<string, string> = {
  openrouter: DEFAULT_OPENROUTER_MODEL_ID,
  anthropic: "claude-sonnet-5",
  deepseek: "deepseek-flash",
};

/** Record id binding an admin's encrypted key to its connection row. */
export function deploymentConnectionRecord(provider: string): string {
  return `deployment-model:${provider}`;
}

/**
 * What Pi reports for a provider that authenticates from the host instead of a key: an AWS
 * profile or task role for Amazon Bedrock, Application Default Credentials for Vertex.
 */
const HOST_CREDENTIALS = "<authenticated>";

/** What a provider's host credentials are, for telling a user what a deployment runs on. */
const HOST_CREDENTIAL_SOURCES: Record<string, string> = {
  "amazon-bedrock": "AWS IAM",
  "google-vertex": "Google Cloud",
};

/** The kind of host credentials a provider authenticates with, e.g. "AWS IAM". */
export function hostCredentialSource(provider: string): string {
  return HOST_CREDENTIAL_SOURCES[provider] ?? "host";
}

/**
 * The deployment-wide model default: which provider a run falls back to when no user
 * credential applies, and the key for that provider.
 *
 * Keyless host authentication requires explicit opt-in and a model id. Bedrock resolves
 * its credential chain (including instance roles) at request time; local models must be
 * declared by the operator; other providers must report host credentials in the process
 * environment. Host credentials never become `key`.
 *
 * Vendor env names and model ids live here, in the adapter layer, not in core.
 */
export function resolveDeploymentModel(env: NodeJS.ProcessEnv = process.env) {
  const provider = env.PI_DEFAULT_PROVIDER?.trim() || "openrouter";
  const explicitModel = env.PI_DEFAULT_MODEL?.trim();
  // An unknown provider gets no key rather than another vendor's.
  const keyEnv = Object.hasOwn(DEPLOYMENT_KEY_ENV, provider)
    ? DEPLOYMENT_KEY_ENV[provider]
    : undefined;
  const key = keyEnv ? env[keyEnv] : undefined;
  const hostCredentials =
    !key &&
    Boolean(explicitModel) &&
    env.PI_DEFAULT_CREDENTIALS?.trim() === "host" &&
    // Bedrock also resolves EC2 instance roles through IMDS at request time.
    (provider === LOCAL_PROVIDER_ID
      ? localModelIds(env).includes(explicitModel!)
      : provider === "amazon-bedrock" || getEnvApiKey(provider) === HOST_CREDENTIALS);
  return {
    provider,
    model:
      explicitModel || DEPLOYMENT_DEFAULT_MODELS[provider] || DEPLOYMENT_DEFAULT_MODELS.openrouter!,
    key,
    configured: Boolean(key) || hostCredentials,
    hostCredentials,
  };
}

export type DeploymentModel = ReturnType<typeof resolveDeploymentModel> & {
  /** An admin's saved choice, which stands in for members even where only a run can key it. */
  chosen?: boolean;
};

/** A model connection the deployment owns. */
export type DeploymentConnection = {
  provider: string;
  source: "environment" | "settings";
  /** The environment's key. */
  key?: string;
  /** An admin's key or endpoint, encrypted; read with deploymentConnectionSecret. */
  ciphertext?: string;
  /** Runs without a key: host credentials or the local model server. */
  keyless?: boolean;
  /** The model ids it runs when it names them itself, as a local or compatible server does. */
  models?: string[];
};

/** The deployment's models: its default, its connections and what members may use on them. */
export type DeploymentModels = {
  default: DeploymentModel;
  connections: DeploymentConnection[];
  /** Normalized allowlist entries: `provider:model`, `provider:*` or `*`. */
  allowed: string[];
  /**
   * Model credits pay for deployment models: members then run them only through hosted credits,
   * exactly as before deployment models, so none are served on the allowlist or as the default.
   */
  creditsOnly?: boolean;
};

/** The deployment settings columns an admin saves. */
export type SavedDeploymentModels = {
  defaultModelProvider?: string | null;
  defaultModelId?: string | null;
  allowedModels?: string | null;
  modelCreditsEnabled?: boolean;
  /** The connections admins added; read with DEPLOYMENT_MODEL_SETTINGS. */
  modelConnections?: readonly { provider: string; ciphertext: string; models?: string[] }[];
};

/** Include for a deployment settings read that also loads the admins' connections. */
export const DEPLOYMENT_MODEL_SETTINGS = {
  modelConnections: {
    select: { provider: true, ciphertext: true, models: true },
    orderBy: { provider: "asc" },
  },
} as const;

/** Allowlist entries with canonical provider ids; anything malformed is dropped. */
export function parseModelAllowlist(value: string | null | undefined): string[] {
  const entries = (value ?? "")
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .flatMap((entry) => {
      if (entry === "*") return [entry];
      const colon = entry.indexOf(":");
      const provider = entry.slice(0, colon).trim();
      const model = entry.slice(colon + 1).trim();
      return colon > 0 && model ? [`${canonicalPiProviderId(provider)}:${model}`] : [];
    });
  return [...new Set(entries)];
}

/** Whether the allowlist opens any of a provider's models: all of them, or ones it names. */
export function allowlistOpens(allowed: readonly string[], provider: string): boolean {
  const canonical = canonicalPiProviderId(provider);
  return allowed.some((entry) => entry === "*" || entry.startsWith(`${canonical}:`));
}

/**
 * The allowlist with all of one provider's models opened, or every one of them closed, and
 * other entries kept. `*` becomes one entry per connected provider, so one of them can close.
 */
export function allowlistWithProvider(
  allowed: readonly string[],
  providers: readonly string[],
  provider: string,
  open: boolean,
): string[] {
  const canonical = canonicalPiProviderId(provider);
  const expanded = allowed.includes("*")
    ? [
        ...allowed.filter((entry) => entry !== "*"),
        ...providers.map((id) => `${canonicalPiProviderId(id)}:*`),
      ]
    : [...allowed];
  const rest = expanded.filter((entry) => !entry.startsWith(`${canonical}:`));
  return [...new Set(open ? [...rest, `${canonical}:*`] : rest)];
}

/** The deployment's models as its environment configures them. Read once per process. */
export function environmentDeploymentModels(
  env: NodeJS.ProcessEnv = process.env,
  fallback: DeploymentModel = resolveDeploymentModel(env),
): DeploymentModels {
  const connections: DeploymentConnection[] = Object.entries(DEPLOYMENT_KEY_ENV).flatMap(
    ([provider, name]) =>
      env[name] ? [{ provider, source: "environment" as const, key: env[name] }] : [],
  );
  const local = localModelIds(env);
  if (local.length)
    connections.push({
      provider: LOCAL_PROVIDER_ID,
      source: "environment",
      keyless: true,
      models: local,
    });
  if (fallback.hostCredentials && !connections.some((c) => c.provider === fallback.provider))
    connections.push({ provider: fallback.provider, source: "environment", keyless: true });
  return { default: fallback, connections, allowed: parseModelAllowlist(env.PI_DEPLOYMENT_MODELS) };
}

/**
 * The environment's models from what a caller holds of its default alone: its connection
 * and no allowlist. For callers built before the full environment was passed through.
 */
export function defaultOnlyDeploymentModels(fallback: DeploymentModel): DeploymentModels {
  return {
    default: fallback,
    connections:
      fallback.key || fallback.configured || fallback.hostCredentials
        ? [
            {
              provider: fallback.provider,
              source: "environment",
              key: fallback.key,
              keyless: !fallback.key,
            },
          ]
        : [],
    allowed: [],
  };
}

/**
 * Applies an admin's settings over the environment's: their connections replace the
 * environment's for the same provider, and their default model and allowlist replace the
 * environment's when set. A saved default an admin's connection no longer lists, as after an
 * endpoint edit, gives way to the environment's. While model credits bill, the default stays the
 * environment's, the provider credits pay for.
 */
export function applyDeploymentModelSettings(
  environment: DeploymentModels,
  saved: SavedDeploymentModels | null | undefined,
  options: { creditsOnly?: boolean } = {},
): DeploymentModels {
  const adminConnections = saved?.modelConnections ?? [];
  const byProvider = new Map(environment.connections.map((entry) => [entry.provider, entry]));
  for (const row of adminConnections)
    byProvider.set(row.provider, {
      provider: row.provider,
      source: "settings",
      ciphertext: row.ciphertext,
      ...(row.models?.length ? { models: row.models } : {}),
    });
  const connections = [...byProvider.values()];
  const creditsOnly = options.creditsOnly ?? saved?.modelCreditsEnabled === true;
  const env = environment.default;
  const keyFor = (provider: string) => {
    const connection = byProvider.get(provider);
    const environmentKey = provider === env.provider && connection?.source !== "settings";
    return {
      key: environmentKey ? env.key : connection?.key,
      hostCredentials: environmentKey && env.hostCredentials,
    };
  };
  // The environment's own default keeps exactly the rules it has always had. An admin's
  // connection that replaces its provider runs it too, unless it names models without it.
  const replacement = byProvider.get(env.provider);
  const environmentDefault: DeploymentModel = {
    ...env,
    ...keyFor(env.provider),
    configured:
      replacement?.source === "settings"
        ? !replacement.models || replacement.models.includes(env.model)
        : env.configured,
  };
  const provider = saved?.defaultModelProvider?.trim();
  const model = usableModelId(saved?.defaultModelId) ?? env.model;
  const connection = provider ? byProvider.get(provider) : undefined;
  const dropped =
    connection?.source === "settings" &&
    Boolean(connection.models) &&
    !connection.models!.includes(model);
  const configured =
    provider === env.provider && model === env.model
      ? environmentDefault.configured
      : Boolean(connection && !dropped);
  return {
    default:
      provider && !dropped && !creditsOnly
        ? { provider, model, ...keyFor(provider), configured, chosen: true }
        : environmentDefault,
    connections,
    allowed:
      saved?.allowedModels != null ? parseModelAllowlist(saved.allowedModels) : environment.allowed,
    ...(creditsOnly ? { creditsOnly: true } : {}),
  };
}

/**
 * Models the deployment serves that a catalog does not list, as an endpoint's are, named after the
 * catalog's provider where it has one.
 */
export function servedModelsOutsideCatalog(
  catalog: readonly { provider: string; providerName?: string; id: string }[],
  served: Iterable<string> | undefined,
): Array<{ provider: string; providerName?: string; id: string }> {
  const listed = new Set(catalog.map((entry) => `${entry.provider}:${entry.id}`));
  return [...(served ?? [])]
    .filter((key) => !listed.has(key))
    .map((key) => {
      const provider = key.slice(0, key.indexOf(":"));
      const providerName = catalog.find((entry) => entry.provider === provider)?.providerName;
      return {
        provider,
        ...(providerName ? { providerName } : {}),
        id: key.slice(provider.length + 1),
      };
    });
}

/**
 * The default that stands in for a member who chose nothing: one the deployment can run, or an
 * admin's saved choice, which the run then keys or refuses as it always has.
 */
export function deploymentStandIn(models: DeploymentModels): DeploymentModel | null {
  return models.default.configured || models.default.chosen ? models.default : null;
}

/**
 * Reads an admin's settings at use time, so every process follows a change without a restart.
 * Pass the settings row when it is already loaded, with DEPLOYMENT_MODEL_SETTINGS included, and
 * whether model credits bill when the caller knows better than that row.
 */
export async function loadDeploymentModels(
  prisma: PrismaClient,
  environment: DeploymentModels = environmentDeploymentModels(),
  saved?: SavedDeploymentModels | null,
  options: { creditsOnly?: boolean } = {},
): Promise<DeploymentModels> {
  const settings =
    saved !== undefined
      ? saved
      : await runAsSystem("read the deployment's models", () =>
          prisma.deploymentSettings.findUnique({
            where: { id: "default" },
            include: DEPLOYMENT_MODEL_SETTINGS,
          }),
        );
  return applyDeploymentModelSettings(environment, settings, options);
}

/** The deployment's connection for a provider. */
export function deploymentConnection(
  models: DeploymentModels,
  provider: string,
): DeploymentConnection | undefined {
  const canonical = canonicalPiProviderId(provider);
  return models.connections.find((entry) => canonicalPiProviderId(entry.provider) === canonical);
}

/**
 * The deployment connection that may run a model, or none. A deployment key is a bearer credential
 * for exactly one vendor, so it goes only to that vendor's models a member may run on it: the
 * default model or one the allowlist names. Hosted credits fund their provider's models, and the
 * environment's own key for its default provider keeps serving any of that provider's models, as
 * it always has.
 */
export function entitledDeploymentConnection(
  models: DeploymentModels,
  input: {
    environmentProvider: string;
    provider: string;
    modelId: string;
    hostedCredits?: boolean;
  },
): DeploymentConnection | undefined {
  const candidate = deploymentConnection(models, input.provider);
  const environmentProvider =
    canonicalPiProviderId(input.provider) === canonicalPiProviderId(input.environmentProvider);
  return deploymentServes(models, input.provider, input.modelId) ||
    (environmentProvider && (input.hostedCredits || candidate?.source === "environment"))
    ? candidate
    : undefined;
}

let catalogIds: { catalog: readonly unknown[]; byProvider: Map<string, string[]> } | undefined;

/** Model ids of a provider's bundled catalog that members can be offered. */
function catalogModelIds(provider: string): string[] {
  const catalog = listPiCatalog();
  if (catalogIds?.catalog !== catalog) {
    const byProvider = new Map<string, string[]>();
    for (const entry of offeredCatalog(catalog))
      if (!entry.placeholder)
        byProvider.set(entry.provider, [...(byProvider.get(entry.provider) ?? []), entry.id]);
    catalogIds = { catalog, byProvider };
  }
  return catalogIds.byProvider.get(provider) ?? [];
}

/** The ids a connection can run: those it names, else its provider's catalog. */
export function deploymentConnectionModels(connection: DeploymentConnection): string[] {
  return connection.models ?? catalogModelIds(canonicalPiProviderId(connection.provider));
}

/**
 * Whether the deployment's own connection runs this model for a member who has none for it:
 * the default model, or a model of a deployment connection the allowlist names.
 */
export function deploymentServes(
  models: DeploymentModels | null | undefined,
  provider: string | null | undefined,
  modelId: string | null | undefined,
): boolean {
  const id = usableModelId(modelId);
  if (!models || models.creditsOnly || !provider || !id) return false;
  const canonical = canonicalPiProviderId(provider);
  const fallback = models.default;
  if (
    fallback.configured &&
    canonicalPiProviderId(fallback.provider) === canonical &&
    fallback.model === id
  )
    return true;
  const connection = deploymentConnection(models, canonical);
  if (!connection || !deploymentConnectionModels(connection).includes(id)) return false;
  return models.allowed.some(
    (entry) => entry === "*" || entry === `${canonical}:*` || entry === `${canonical}:${id}`,
  );
}

/** Every model the deployment serves to members, default first. */
export function deploymentServedModels(models: DeploymentModels) {
  if (models.creditsOnly) return [];
  const served = models.default.configured
    ? [{ provider: canonicalPiProviderId(models.default.provider), id: models.default.model }]
    : [];
  for (const connection of models.connections)
    for (const id of deploymentConnectionModels(connection))
      if (deploymentServes(models, connection.provider, id))
        served.push({ provider: canonicalPiProviderId(connection.provider), id });
  return [...new Map(served.map((entry) => [`${entry.provider}:${entry.id}`, entry])).values()];
}

/**
 * The secret a deployment connection runs with, in a member connection's shape. An admin's is
 * decrypted only when a call needs it.
 */
export async function deploymentConnectionSecret(
  secrets: Pick<SecretStore, "load">,
  connection: DeploymentConnection | undefined,
): Promise<StoredModelSecret | undefined> {
  if (connection?.ciphertext)
    return parseModelSecret(
      await secrets.load(connection.ciphertext, deploymentConnectionRecord(connection.provider)),
    );
  return connection?.key ? { kind: "api_key", key: connection.key } : undefined;
}

/**
 * Providers an admin can connect for the deployment: catalog providers that need only an API
 * key, and an OpenAI-compatible endpoint, which connects with its URL and model ids.
 */
export function deploymentConnectableProviders() {
  const providers = new Map<string, { id: string; name: string; endpoint?: true }>();
  for (const entry of offeredCatalog(listPiCatalog())) {
    const endpoint = entry.provider === OPENAI_COMPATIBLE_PROVIDER_ID;
    if (
      providers.has(entry.provider) ||
      (!endpoint &&
        (entry.placeholder ||
          entry.auth === "oauth" ||
          entry.routingFields?.length ||
          [LOCAL_PROVIDER_ID, "scripted"].includes(entry.provider)))
    )
      continue;
    providers.set(entry.provider, {
      id: entry.provider,
      name: entry.providerName,
      ...(endpoint ? { endpoint: true as const } : {}),
    });
  }
  return [...providers.values()];
}

/** A connection's name and its models' labels, as the catalog gives them. */
export function describeDeploymentConnection(connection: DeploymentConnection) {
  const provider = canonicalPiProviderId(connection.provider);
  const entries = listPiCatalog().filter((entry) => entry.provider === provider);
  const labels = new Map(entries.map((entry) => [entry.id, entry.label]));
  return {
    name: entries[0]?.providerName ?? provider,
    models: deploymentConnectionModels(connection).map((id) => ({
      id,
      label: labels.get(id) ?? id,
    })),
  };
}

/** Looks up a call's cost on the key that runs that provider now, when it can. */
export function deploymentModelUsageLookup(deps: {
  prisma: PrismaClient;
  secretStore: Pick<SecretStore, "load">;
}): () => Promise<ModelUsageLookup | undefined> {
  return async () => {
    const models = await loadDeploymentModels(deps.prisma);
    const secret = await deploymentConnectionSecret(
      deps.secretStore,
      deploymentConnection(models, "openrouter"),
    );
    return secret?.kind === "api_key" ? new OpenRouterUsageLookup(secret.key) : undefined;
  };
}
