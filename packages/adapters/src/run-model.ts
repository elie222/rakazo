import type {
  AgentModelOAuthCredential,
  AgentRunRequest,
  AgentRuntime,
  ModelCredentialFailedState,
  ModelCredentialRetireReason,
} from "@rakazo/adapter-kit";
import { canonicalPiProviderId, OPENAI_COMPATIBLE_PROVIDER_ID } from "@rakazo/contracts";
import { MISSING_MODEL_RUN_ERROR } from "@rakazo/core";
import {
  CLOUDFLARE_AI_GATEWAY_CONFIG_MESSAGE,
  CLOUDFLARE_WORKERS_AI_PROVIDER_ID,
  cloudflareModelConfigMessage,
  cloudflareProviderEnv,
} from "./cloudflare-ai-gateway.js";
import type { DeploymentModels, SavedDeploymentModels } from "./deployment-model.js";
import {
  DEPLOYMENT_MODEL_SETTINGS,
  defaultOnlyDeploymentModels,
  deploymentConnection,
  deploymentConnectionSecret,
  deploymentServes,
  deploymentStandIn,
  loadDeploymentModels,
  resolveDeploymentModel,
} from "./deployment-model.js";
import type { ExecutorDeps } from "./executor-deps.js";
import type { FleetPrepareDeps } from "./fleet-tools.js";
import {
  kickModelCredentialRefresh,
  persistStoredModelSecret,
  refreshStoredModelCredential,
  resolveStoredModelAuth,
  retireToReconnectMarker,
  withModelCredentialLock,
} from "./model-credential-refresh.js";
import {
  HostedModelCreditsRequiredError,
  hostedModelCreditObserver,
} from "./model-credit-observer.js";
import { resolveMemberMainModel, selectConfiguredModel } from "./model-roles.js";
import { storedSecretRunFields } from "./model-run-fields.js";
import type { StoredModelSecret } from "./model-secret.js";
import { parseModelSecret, secretValuesToRedact, serializeModelSecret } from "./model-secret.js";
import {
  enabledOpenAiCompatibleModelIds,
  findConnectedModelCredential,
  hasHostedModelCredits,
  PINNED_PROVIDER_NOT_CONNECTED,
  UnavailableModelForAuthError,
  validateConnectedModelChoice,
  validateModelAuthAvailability,
} from "./model-selection.js";
import { compatibleModelSeesImages } from "./model-vision.js";
import { codexLiveModel } from "./pi-codex-catalog.js";
import { toOAuthCredential } from "./pi-credentials.js";
import { LOCAL_PROVIDER_ID } from "./pi-local-provider.js";
import { CHATGPT_OAUTH_PROVIDER, isRetiredModelCredentialError } from "./pi-oauth.js";

export function runtimeFallbackModel(runtime: AgentRuntime) {
  return runtime.describe().capabilities.scripted ? { provider: "scripted", id: "scripted" } : null;
}

export function isTerminalModelSetupError(error: unknown): boolean {
  return (
    error instanceof UnavailableModelForAuthError ||
    error instanceof HostedModelCreditsRequiredError ||
    isRetiredModelCredentialError(error) ||
    (error instanceof Error &&
      (error.message === CLOUDFLARE_AI_GATEWAY_CONFIG_MESSAGE ||
        error.message === cloudflareModelConfigMessage(CLOUDFLARE_WORKERS_AI_PROVIDER_ID)))
  );
}

/**
 * The deployment's models now: the environment's as this process read it, with an admin's
 * settings applied. Pass the settings row when it is already loaded.
 */
export function runDeploymentModels(
  deps: Pick<
    ExecutorDeps,
    | "prisma"
    | "deploymentModels"
    | "deploymentModelKey"
    | "deploymentModelConfigured"
    | "billingEnabled"
  >,
  saved?: SavedDeploymentModels | null,
): Promise<DeploymentModels> {
  const environment =
    deps.deploymentModels ??
    defaultOnlyDeploymentModels({
      ...resolveDeploymentModel(),
      key: deps.deploymentModelKey,
      configured: Boolean(deps.deploymentModelConfigured),
    });
  // A process told whether model credits bill knows better than the settings row it was given.
  return loadDeploymentModels(deps.prisma, environment, saved, {
    creditsOnly: deps.billingEnabled,
  });
}

/** The default model's provider while hosted credits pay for it. */
async function hostedDeploymentProvider(
  deps: Parameters<typeof runDeploymentModels>[0] & Pick<ExecutorDeps, "billingEnabled">,
  models?: DeploymentModels,
) {
  if (!(await modelCreditBillingEnabled(deps))) return undefined;
  return (models ?? (await runDeploymentModels(deps))).default.provider;
}

export async function fleetPrepareDeps(
  deps: ExecutorDeps,
  scope: { userId: string; spaceId: string },
): Promise<FleetPrepareDeps> {
  const deployment = await runDeploymentModels(deps);
  const hostedProvider = await hostedDeploymentProvider(deps, deployment);
  return {
    prisma: deps.prisma,
    modelChange: {
      hostedProvider,
      deployment,
      secretStore: deps.secretStore,
      codexCatalog: deps.codexCatalog,
      refreshExpiredCredential: (credentialScope, secretId, provider) =>
        kickModelCredentialRefresh(
          deps.prisma,
          deps.secretStore,
          credentialScope,
          secretId,
          provider,
        ),
      defaultModel: async () => {
        const [main, settings] = await Promise.all([
          resolveMemberMainModel(deps, scope),
          deps.prisma.deploymentSettings.findUnique({
            where: { id: "default" },
            include: DEPLOYMENT_MODEL_SETTINGS,
          }),
        ]);
        const models = await runDeploymentModels(deps, settings);
        const selected = selectConfiguredModel({
          override: null,
          overrideCredential: null,
          main,
          hostedProvider,
          deploymentModels: models,
          defaults: { deployment: deploymentStandIn(models) },
        });
        return { provider: selected.provider ?? null, model: selected.id ?? null };
      },
    },
  };
}

/** The default model the environment configures, before any admin setting. */
function environmentDefault(deps: Pick<ExecutorDeps, "deploymentModels">) {
  return deps.deploymentModels?.default ?? resolveDeploymentModel();
}

/**
 * A deployment key is a bearer credential for exactly one vendor, so it is handed out only for
 * that vendor's models a member may run on it: the default model or one the allowlist names.
 * Hosted credits, checked by the caller, fund their provider's models. The environment's own key
 * for its default provider keeps serving any of that provider's models, as it always has.
 */
async function deploymentKeyFor(
  deps: ExecutorDeps,
  provider: string,
  modelId: string,
  registerSecrets?: (values: string[]) => void,
  hostedCredits = false,
) {
  const models = await runDeploymentModels(deps);
  const environmentProvider =
    canonicalPiProviderId(provider) === canonicalPiProviderId(environmentDefault(deps).provider);
  const candidate = deploymentConnection(models, provider);
  const entitled =
    deploymentServes(models, provider, modelId) ||
    (environmentProvider && (hostedCredits || candidate?.source === "environment"));
  const connection = entitled ? candidate : undefined;
  const secret = await deploymentConnectionSecret(deps.secretStore, connection);
  if (!secret || secret.kind === "oauth") {
    cloudflareProviderEnv({ provider });
    return { apiKey: undefined, redact: [] };
  }
  // The environment's keys are redacted from every run already; an admin's joins each run,
  // switch, fallback and checker that uses it.
  const redact = connection?.ciphertext ? secretValuesToRedact(secret) : [];
  if (redact.length) registerSecrets?.(redact);
  return {
    apiKey: secret.kind === "api_key" ? secret.key : secret.apiKey,
    ...storedSecretRunFields(
      deps,
      provider,
      secret,
      secret.kind === "openai_compatible"
        ? compatibleModelSeesImages({}, secret, modelId)
        : undefined,
    ),
    redact,
  };
}

/**
 * A run can afford a longer catalog wait than the models.list read bound — the
 * account answer decides whether a statically excluded model is allowed at all.
 * Still bounded well under the fetch's own abort timeout.
 */
const CODEX_LIVE_RUN_WAIT_MS = 8_000;

// Listed connections serve enabled ids and their space default; legacy connections serve any id.
function assertCompatibleModelEnabled(
  credential: { provider: string; defaultModel?: string | null },
  secret: StoredModelSecret,
  modelId: string,
) {
  if (credential.provider !== OPENAI_COMPATIBLE_PROVIDER_ID) return;
  if (secret.kind !== "openai_compatible") return;
  if (secret.enabledModelIds !== undefined) {
    if (!enabledOpenAiCompatibleModelIds(secret, credential.defaultModel).includes(modelId)) {
      throw new UnavailableModelForAuthError("Unknown model for that provider");
    }
    return;
  }
}

export async function modelCreditBillingEnabled(
  deps: Pick<ExecutorDeps, "prisma" | "billingEnabled">,
): Promise<boolean> {
  if (deps.billingEnabled !== undefined) return deps.billingEnabled;
  return (
    (
      await deps.prisma.deploymentSettings.findUnique({
        where: { id: "default" },
        select: { modelCreditsEnabled: true },
      })
    )?.modelCreditsEnabled === true
  );
}

export async function resolveModelKey(...args: Parameters<typeof resolveModelKeyMaterial>) {
  const [deps, userId, spaceId, , provider] = args;
  const billingEnabled = await modelCreditBillingEnabled(deps);
  const scope = { userId, spaceId };
  if (billingEnabled && (await hasHostedModelCredits(deps.prisma, scope, provider))) {
    args[3] = null;
    // Funded managed backups use deployment credentials just like the primary.
    args[7] = { ...args[7], requireStoredSecret: false, hostedCredits: true };
  } else if (
    !args[3] &&
    args[7]?.requireStoredSecret &&
    deploymentServes(await runDeploymentModels(deps), provider, args[5])
  ) {
    // So do backups and fallbacks the deployment serves members.
    args[7] = { ...args[7], requireStoredSecret: false };
  }
  const credential = args[3];
  const material = await resolveModelKeyMaterial(...args);
  // Local and compatible endpoints can intentionally be keyless. Host auth is
  // allowed only for the deployment provider that explicitly opted into it.
  const keyless = async () => {
    if (
      provider === LOCAL_PROVIDER_ID ||
      (provider === OPENAI_COMPATIBLE_PROVIDER_ID && Boolean(material.baseUrl)) ||
      (provider === "scripted" && deps.runtime?.describe().capabilities.scripted)
    )
      return true;
    if (credential) return false;
    const models = await runDeploymentModels(deps);
    if (!deploymentConnection(models, provider)?.keyless) return false;
    const environment = environmentDefault(deps);
    return (
      (environment.hostCredentials && environment.provider === provider) ||
      deploymentServes(models, provider, args[5])
    );
  };
  // Match Pi's OpenRouter fallback only when no explicit key overrides it.
  const runtimeKey =
    material.apiKey === undefined && (provider === "openrouter" || provider === "scripted")
      ? process.env.OPENROUTER_API_KEY
      : undefined;
  if (!material.apiKey?.trim() && !runtimeKey?.trim() && !(await keyless())) {
    throw new UnavailableModelForAuthError(MISSING_MODEL_RUN_ERROR);
  }
  const callObserver =
    !credential && billingEnabled ? await hostedModelCreditObserver(deps.prisma, scope) : undefined;
  return { ...material, apiKey: material.apiKey ?? runtimeKey, callObserver };
}

async function resolveModelKeyMaterial(
  deps: ExecutorDeps,
  userId: string,
  spaceId: string,
  credential: {
    id: string;
    secretId: string;
    provider: string;
    defaultModel?: string | null;
    supportsImages?: boolean;
  } | null,
  provider: string,
  modelId: string,
  registerSecrets?: (values: string[]) => void,
  {
    requireStoredSecret = false,
    hostedCredits = false,
  }: { requireStoredSecret?: boolean; hostedCredits?: boolean } = {},
): Promise<{
  apiKey?: string;
  accountId?: string;
  gatewayId?: string;
  baseUrl?: string;
  apiProtocol?: AgentRunRequest["model"]["apiProtocol"];
  headers?: Record<string, string>;
  allowPrivateEndpoint?: boolean;
  cacheCapabilities?: AgentRunRequest["model"]["cacheCapabilities"];
  contextWindow?: number;
  reasoning?: boolean;
  maxTokens?: number;
  thinkingLevel?: AgentRunRequest["model"]["thinkingLevel"];
  acceptsImages?: boolean;
  maxImagesPerPrompt?: number;
  oauth?: AgentModelOAuthCredential;
  persistOAuth?: (credential: AgentModelOAuthCredential) => Promise<void>;
  refreshOAuth?: NonNullable<NonNullable<AgentRunRequest["model"]["oauth"]>["refresh"]>;
  retireOAuth?: (
    reason: ModelCredentialRetireReason,
    detail?: string,
    failed?: ModelCredentialFailedState,
  ) => Promise<boolean | undefined>;
  /** The key is the user's own stored connection, not the deployment's. */
  ownCredential?: true;
  redact: string[];
}> {
  if (credential) {
    return withModelCredentialLock(credential.secretId, async () => {
      const row = await deps.prisma.secret.findFirst({
        where: { id: credential.secretId, userId, spaceId: null },
      });
      if (!row) {
        if (await modelCreditBillingEnabled(deps))
          throw new Error("Connect that model provider again.");
        if (requireStoredSecret) throw new Error("Backup model credential is no longer available");
        if (credential.provider === OPENAI_COMPATIBLE_PROVIDER_ID) {
          throw new UnavailableModelForAuthError("Unknown model for that provider");
        }
        return deploymentKeyFor(deps, provider, modelId, registerSecrets, hostedCredits);
      }
      const plaintext = await deps.secretStore.load(row.ciphertext, row.id);
      registerSecrets?.(secretValuesToRedact(parseModelSecret(plaintext)));
      const persist = persistStoredModelSecret(
        deps.prisma,
        deps.secretStore,
        { userId, spaceId },
        row.id,
      );
      const retire = retireToReconnectMarker(
        deps.prisma,
        deps.secretStore,
        { userId, spaceId },
        credential,
        parseModelSecret(plaintext).maxTokens,
      );
      const resolveAuth = () =>
        resolveStoredModelAuth(
          deps.prisma,
          deps.secretStore,
          { userId, spaceId },
          credential,
          plaintext,
          credential.provider,
        );
      let resolved: Awaited<ReturnType<typeof resolveAuth>> | undefined;
      let liveCodex: Awaited<ReturnType<typeof codexLiveModel>> | undefined;
      const authError = validateModelAuthAvailability(provider, modelId, plaintext);
      if (authError) {
        // A statically excluded Codex model may still run when the backend's
        // per-account catalog lists it for this credential. The catalog path
        // never refreshes or writes credentials, so resolve inside this lock
        // first — rotating a stale token the way any run would — then ask.
        if (deps.codexCatalog && parseModelSecret(plaintext).kind === "oauth") {
          resolved = await resolveAuth();
          liveCodex = await codexLiveModel(deps.codexCatalog, userId, resolved.secret, modelId, {
            waitMs: CODEX_LIVE_RUN_WAIT_MS,
          });
        }
        if (!liveCodex) throw new UnavailableModelForAuthError(authError);
      }
      resolved ??= await resolveAuth();
      if (
        !liveCodex &&
        deps.codexCatalog &&
        provider === CHATGPT_OAUTH_PROVIDER &&
        resolved.secret.kind === "oauth"
      ) {
        liveCodex = await codexLiveModel(deps.codexCatalog, userId, resolved.secret, modelId, {
          waitMs: CODEX_LIVE_RUN_WAIT_MS,
        });
      }
      assertCompatibleModelEnabled(credential, resolved.secret, modelId);
      const oauth = resolved.secret.kind === "oauth" ? resolved.secret.credential : undefined;
      const fields = storedSecretRunFields(
        deps,
        provider,
        resolved.secret,
        credential.provider === OPENAI_COMPATIBLE_PROVIDER_ID &&
          resolved.secret.kind === "openai_compatible"
          ? compatibleModelSeesImages(credential, resolved.secret, modelId)
          : liveCodex?.supportsImages,
      );
      return {
        apiKey: resolved.apiKey,
        ...fields,
        oauth,
        persistOAuth: oauth
          ? async (next) => {
              await withModelCredentialLock(credential.secretId, async () => {
                const currentRow = await deps.prisma.secret.findFirst({
                  where: { id: credential.secretId, userId, spaceId: null },
                });
                if (!currentRow) return;
                const current = parseModelSecret(
                  await deps.secretStore.load(currentRow.ciphertext, currentRow.id),
                );
                if (current.kind === "oauth" && !current.reconnectRequired) {
                  const stored = current.credential;
                  if (stored.expires > next.expires) return;
                  if (
                    stored.access === next.access &&
                    stored.refresh === next.refresh &&
                    stored.expires === next.expires
                  ) {
                    return;
                  }
                }
                await persist(
                  serializeModelSecret({
                    kind: "oauth",
                    credential: toOAuthCredential(next),
                    ...(current.maxTokens !== undefined ? { maxTokens: current.maxTokens } : {}),
                  }),
                );
              });
            }
          : undefined,
        refreshOAuth: oauth
          ? refreshStoredModelCredential(
              deps.prisma,
              deps.secretStore,
              { userId, spaceId },
              credential,
              credential.provider,
            )
          : undefined,
        retireOAuth: retire,
        ownCredential: true,
        redact: [...secretValuesToRedact(resolved.secret), resolved.apiKey].filter(
          (value): value is string => Boolean(value),
        ),
      };
    });
  }
  if (requireStoredSecret) throw new Error("Backup model credential is no longer available");
  return deploymentKeyFor(deps, provider, modelId, registerSecrets, hostedCredits);
}

/** Translate resolved credentials and capabilities consistently for every run path. */
export function resolvedModelRunFields(
  resolved: Awaited<ReturnType<typeof resolveModelKey>>,
): Omit<AgentRunRequest["model"], "provider" | "id" | "connectionId" | "thinkingLevel"> {
  return {
    apiKey: resolved.oauth ? undefined : resolved.apiKey,
    callObserver: resolved.callObserver,
    ...(resolved.accountId ? { accountId: resolved.accountId } : {}),
    ...(resolved.gatewayId ? { gatewayId: resolved.gatewayId } : {}),
    baseUrl: resolved.baseUrl,
    apiProtocol: resolved.apiProtocol,
    headers: resolved.headers,
    allowPrivateEndpoint: resolved.allowPrivateEndpoint,
    cacheCapabilities: resolved.cacheCapabilities,
    contextWindow: resolved.contextWindow,
    reasoning: resolved.reasoning,
    maxTokens: resolved.maxTokens,
    acceptsImages: resolved.acceptsImages,
    maxImagesPerPrompt: resolved.maxImagesPerPrompt,
    oauth: resolved.oauth
      ? {
          credential: resolved.oauth,
          persist: resolved.persistOAuth,
          refresh: resolved.refreshOAuth,
          retire: resolved.retireOAuth,
        }
      : undefined,
  };
}

/**
 * A role row's model on its own connection, or on the deployment's for its funded provider.
 * The connection is returned with the key so a run can record which one served it.
 */
export async function resolveConnectedModelKey(
  deps: ExecutorDeps,
  scope: { userId: string; spaceId: string },
  provider: string,
  modelId: string,
  registerSecrets?: (values: string[]) => void,
  requireStoredSecret = false,
  credentialId?: string,
) {
  const hostedProvider = await hostedDeploymentProvider(deps);
  // Read only when no connection of the member's serves the model. A row pinned to a
  // connection runs only there, never on the deployment's.
  let models: Promise<DeploymentModels> | undefined;
  const deployment = async () => {
    if (credentialId) return undefined;
    models ??= runDeploymentModels(deps);
    return models;
  };
  const validationError = await validateConnectedModelChoice(
    deps.prisma,
    deps.secretStore,
    scope,
    provider,
    modelId,
    { hostedProvider, credentialId, codexCatalog: deps.codexCatalog, deployment },
  );
  if (validationError) throw new Error(validationError);
  const credential = await findConnectedModelCredential(
    deps.prisma,
    deps.secretStore,
    scope,
    provider,
    modelId,
    { credentialId },
  );
  if (
    !credential &&
    provider !== hostedProvider &&
    !deploymentServes(await deployment(), provider, modelId)
  )
    throw new Error(PINNED_PROVIDER_NOT_CONNECTED);
  const resolved = await resolveModelKey(
    deps,
    scope.userId,
    scope.spaceId,
    credential,
    provider,
    modelId,
    registerSecrets,
    { requireStoredSecret },
  );
  return { credential, resolved };
}

export async function resolveConnectedRunModel(
  deps: ExecutorDeps,
  scope: { userId: string; spaceId: string },
  provider: string,
  modelId: string,
  registerSecrets?: (values: string[]) => void,
  requireStoredSecret = false,
  /** A fallback's own effort from its role list. */
  thinkingLevel?: string | null,
  /** The connection a role row is pinned to. */
  credentialId?: string,
): Promise<AgentRunRequest["model"]> {
  const { credential, resolved } = await resolveConnectedModelKey(
    deps,
    scope,
    provider,
    modelId,
    registerSecrets,
    requireStoredSecret,
    credentialId,
  );
  return {
    provider,
    id: modelId,
    ...(credentialId ? { connectionId: credentialId } : {}),
    ...resolvedModelRunFields(resolved),
    thinkingLevel:
      ((thinkingLevel !== undefined
        ? thinkingLevel
        : credential?.defaultModel === modelId
          ? credential?.thinkingLevel
          : null) as AgentRunRequest["model"]["thinkingLevel"]) ??
      resolved.thinkingLevel ??
      null,
  };
}

export async function resolveRunModel(
  deps: ExecutorDeps,
  scope: {
    userId: string;
    spaceId: string;
    botId?: string;
  },
): Promise<AgentRunRequest["model"]> {
  // The bot's model is shared config; the credential that runs it stays the run user's.
  const override = scope.botId
    ? await deps.prisma.bot.findFirst({
        where: { id: scope.botId, spaceId: scope.spaceId },
        select: { modelProvider: true, modelId: true, thinkingLevel: true },
      })
    : null;
  const hasOverride = Boolean(override?.modelProvider && override.modelId);
  const [overrideCredential, main, settings] = await Promise.all([
    hasOverride
      ? findConnectedModelCredential(
          deps.prisma,
          deps.secretStore,
          scope,
          override!.modelProvider!,
          override!.modelId,
        )
      : Promise.resolve(null),
    resolveMemberMainModel(deps, scope),
    deps.prisma.deploymentSettings.findUnique({
      where: { id: "default" },
      include: DEPLOYMENT_MODEL_SETTINGS,
    }),
  ]);
  const models = await runDeploymentModels(deps, settings);
  const selected = selectConfiguredModel({
    override,
    overrideCredential,
    main,
    hostedProvider: await hostedDeploymentProvider(deps, models),
    deploymentModels: models,
    defaults: { deployment: deploymentStandIn(models) },
  });
  const { credential, thinkingLevel } = selected;
  let { provider, id } = selected;
  if (!provider || !id) {
    const runtimeFallback = runtimeFallbackModel(deps.runtime);
    provider ??= runtimeFallback?.provider;
    id ??= runtimeFallback?.id ?? null;
  }
  if (!provider || !id) throw new Error(MISSING_MODEL_RUN_ERROR);
  // The key is resolved for the provider that won above, not before it is known.
  const resolved = await resolveModelKey(
    deps,
    scope.userId,
    scope.spaceId,
    credential,
    provider,
    id,
  );
  return {
    provider,
    id,
    ...resolvedModelRunFields(resolved),
    thinkingLevel: thinkingLevel ?? resolved.thinkingLevel ?? null,
  };
}
