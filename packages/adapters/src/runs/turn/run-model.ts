import type {
  AgentModelOAuthCredential,
  AgentRunRequest,
  AgentRuntime,
  ModelCredentialFailedState,
  ModelCredentialRetireReason,
} from "@rakazo/adapter-kit";
import {
  canonicalPiProviderId,
  creditOfferingFromConnectionId,
  OPENAI_COMPATIBLE_PROVIDER_ID,
} from "@rakazo/contracts";
import { MISSING_MODEL_RUN_ERROR } from "@rakazo/core";
import {
  approvedModelCreditOffering,
  modelCreditOfferings,
} from "../../model-credits/offerings.js";
import {
  approvedModelCreditMaterial,
  ModelCreditConnectionUnavailableError,
} from "../../model-credits/routing.js";
import {
  HostedModelCreditsRequiredError,
  hostedModelCreditObserver,
} from "../../models/credits/model-credit-observer.js";
import { resolveDeploymentModel } from "../../models/deployment-model.js";
import {
  CLOUDFLARE_AI_GATEWAY_CONFIG_MESSAGE,
  CLOUDFLARE_WORKERS_AI_PROVIDER_ID,
  cloudflareModelConfigMessage,
  cloudflareProviderEnv,
} from "../../models/endpoints/cloudflare-ai-gateway.js";
import { assertAllowedOpenAiCompatibleUrl } from "../../models/endpoints/openai-compatible-url.js";
import {
  kickModelCredentialRefresh,
  persistRefreshedModelCredential,
  refreshStoredModelCredential,
  resolveStoredModelAuth,
  retireToReconnectMarker,
  withModelCredentialLock,
} from "../../models/model-credential-refresh.js";
import {
  MODEL_PROVIDER_NOT_ALLOWED_ERROR,
  modelProviderAllowed,
  modelProviderAllowlist,
} from "../../models/model-provider-allowlist.js";
import { resolveMemberMainModel, selectConfiguredModel } from "../../models/model-roles.js";
import type { StoredModelSecret } from "../../models/model-secret.js";
import { parseModelSecret, secretValuesToRedact } from "../../models/model-secret.js";
import {
  enabledOpenAiCompatibleModelIds,
  findConnectedModelCredential,
  hasHostedModelCredits,
  ModelConnectionGoneError,
  PINNED_PROVIDER_NOT_CONNECTED,
  UnavailableModelForAuthError,
  validateConnectedModelChoice,
  validateModelAuthAvailability,
} from "../../models/model-selection.js";
import { connectionModelSettings } from "../../models/model-settings.js";
import { codexLiveModel } from "../../runtime/pi/models/pi-codex-catalog.js";
import { LOCAL_PROVIDER_ID } from "../../runtime/pi/models/pi-local-provider.js";
import {
  CHATGPT_OAUTH_PROVIDER,
  isRetiredModelCredentialError,
} from "../../runtime/pi/models/pi-oauth.js";
import type { FleetPrepareDeps } from "../../tools/fleet-tools.js";
import type { ExecutorDeps } from "../executor/executor-deps.js";

export function runtimeFallbackModel(runtime: AgentRuntime) {
  return runtime.describe().capabilities.scripted ? { provider: "scripted", id: "scripted" } : null;
}

export function isTerminalModelSetupError(error: unknown): boolean {
  return (
    error instanceof UnavailableModelForAuthError ||
    error instanceof ModelCreditConnectionUnavailableError ||
    error instanceof HostedModelCreditsRequiredError ||
    isRetiredModelCredentialError(error) ||
    (error instanceof Error &&
      (error.message === CLOUDFLARE_AI_GATEWAY_CONFIG_MESSAGE ||
        error.message === cloudflareModelConfigMessage(CLOUDFLARE_WORKERS_AI_PROVIDER_ID)))
  );
}

export async function fleetPrepareDeps(
  deps: ExecutorDeps,
  scope: { userId: string; spaceId: string },
): Promise<FleetPrepareDeps> {
  const hostedProvider = (await modelCreditBillingEnabled(deps))
    ? resolveDeploymentModel().provider
    : undefined;
  return {
    prisma: deps.prisma,
    ...(deps.inboundEmailDomain ? { inboundEmailDomain: deps.inboundEmailDomain } : {}),
    modelChange: {
      hostedProvider,
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
          deps.prisma.deploymentSettings.findUnique({ where: { id: "default" } }),
        ]);
        const selected = selectConfiguredModel({
          override: null,
          overrideCredential: null,
          main,
          hostedProvider,
          defaults: {
            settings,
            deployment: deps.deploymentModelConfigured ? resolveDeploymentModel() : null,
          },
        });
        return { provider: selected.provider ?? null, model: selected.id ?? null };
      },
    },
  };
}

/**
 * The deployment key is a bearer credential for exactly one vendor, so it is handed out
 * only when the provider that won the resolution above is that vendor. A provider named
 * by deployment settings or a bot override gets no key rather than another vendor's.
 */
function deploymentKeyFor(deps: ExecutorDeps, provider: string): string | undefined {
  if (!deps.deploymentModelKey) return undefined;
  return provider === resolveDeploymentModel().provider ? deps.deploymentModelKey : undefined;
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
  const operatorFunded = args[7]?.operatorFunded === true;
  if (operatorFunded && (args[3] || args[7]?.creditOfferingId || args[7]?.requireStoredSecret))
    throw new UnavailableModelForAuthError("Conflicting model funding sources");
  const billingEnabled = !operatorFunded && (await modelCreditBillingEnabled(deps));
  const scope = { userId, spaceId };
  if (
    modelCreditOfferings() &&
    !args[3] &&
    args[7]?.requireStoredSecret &&
    !args[7]?.creditOfferingId
  )
    throw new UnavailableModelForAuthError("Selected personal connection is unavailable");
  if (!args[3] && billingEnabled && (await hasHostedModelCredits(deps.prisma, scope, provider))) {
    args[3] = null;
    // Funded managed backups use deployment credentials just like the primary.
    args[7] = { ...args[7], requireStoredSecret: false };
  }
  const creditOfferingId = args[7]?.creditOfferingId;
  if (creditOfferingId) {
    if (
      args[3] ||
      !billingEnabled ||
      approvedModelCreditOffering(provider, args[5])?.id !== creditOfferingId ||
      !(await hasHostedModelCredits(deps.prisma, scope, provider, true))
    )
      throw new UnavailableModelForAuthError("Selected credit offering is unavailable");
    args[7] = { ...args[7], requireStoredSecret: false };
  }
  const credential = args[3];
  const material = await resolveModelKeyMaterial(...args);
  const deployment = resolveDeploymentModel();
  // Local and compatible endpoints can intentionally be keyless. Host auth is
  // allowed only for the deployment provider that explicitly opted into it.
  const keyless =
    provider === LOCAL_PROVIDER_ID ||
    (provider === OPENAI_COMPATIBLE_PROVIDER_ID && Boolean(material.baseUrl)) ||
    (provider === "scripted" && deps.runtime?.describe().capabilities.scripted) ||
    (!credential && deployment.provider === provider && deployment.hostCredentials);
  // Match Pi's OpenRouter fallback only when no explicit key overrides it.
  const runtimeKey =
    material.apiKey === undefined && (provider === "openrouter" || provider === "scripted")
      ? process.env.OPENROUTER_API_KEY
      : undefined;
  if (!material.apiKey?.trim() && !runtimeKey?.trim() && !keyless) {
    throw new UnavailableModelForAuthError(MISSING_MODEL_RUN_ERROR);
  }
  const apiKey = material.apiKey ?? runtimeKey;
  if (apiKey) args[6]?.([apiKey]);
  const callObserver =
    !credential && billingEnabled ? await hostedModelCreditObserver(deps.prisma, scope) : undefined;
  const fundingOfferingId =
    creditOfferingId ??
    (!operatorFunded && !credential
      ? approvedModelCreditOffering(provider, args[5])?.id
      : undefined);
  return {
    ...material,
    apiKey,
    redact: [...new Set([...material.redact, ...(apiKey ? [apiKey] : [])])],
    callObserver,
    connectionId: fundingOfferingId ? `credits:${fundingOfferingId}` : credential?.id,
  };
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
    operatorFunded = false,
  }: { requireStoredSecret?: boolean; creditOfferingId?: string; operatorFunded?: boolean } = {},
): Promise<{
  apiKey?: string;
  accountId?: string;
  gatewayId?: string;
  projectId?: string;
  region?: string;
  zeroDataRetention?: boolean;
  baseUrl?: string;
  apiProtocol?: AgentRunRequest["model"]["apiProtocol"];
  headers?: Record<string, string>;
  allowPrivateEndpoint?: boolean;
  cacheCapabilities?: AgentRunRequest["model"]["cacheCapabilities"];
  contextWindow?: number;
  reasoning?: boolean;
  maxTokens?: number;
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
    if (canonicalPiProviderId(credential.provider) !== canonicalPiProviderId(provider))
      throw new UnavailableModelForAuthError("Model connection does not match provider");
    if (!modelProviderAllowed(modelProviderAllowlist(), credential.provider))
      throw new UnavailableModelForAuthError(MODEL_PROVIDER_NOT_ALLOWED_ERROR);
    return withModelCredentialLock(credential.secretId, async () => {
      const row = await deps.prisma.secret.findFirst({
        where: { id: credential.secretId, userId, spaceId: null },
      });
      if (!row) {
        if (modelCreditOfferings() || (await modelCreditBillingEnabled(deps)))
          throw new ModelConnectionGoneError("Connect that model provider again.");
        if (requireStoredSecret)
          throw new ModelConnectionGoneError("Backup model credential is no longer available");
        if (credential.provider === OPENAI_COMPATIBLE_PROVIDER_ID) {
          throw new UnavailableModelForAuthError("Unknown model for that provider");
        }
        cloudflareProviderEnv({ provider });
        return { apiKey: deploymentKeyFor(deps, provider), redact: [] };
      }
      const plaintext = await deps.secretStore.load(row.ciphertext, row.id);
      registerSecrets?.(secretValuesToRedact(parseModelSecret(plaintext)));
      const retire = retireToReconnectMarker(
        deps.prisma,
        deps.secretStore,
        { userId, spaceId },
        credential,
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
      const baseUrl =
        resolved.secret.kind === "openai_compatible" ? resolved.secret.baseUrl : undefined;
      // Recheck operator configuration for saved private connections on every run.
      const allowPrivateEndpoint = baseUrl ? deps.mcpAllowPrivateEndpoint === true : undefined;
      if (baseUrl) {
        try {
          // The public gate stays with the request-time fetch guard.
          assertAllowedOpenAiCompatibleUrl(baseUrl, {
            allowPublic: true,
            allowPrivate: allowPrivateEndpoint,
          });
        } catch (error) {
          throw new UnavailableModelForAuthError((error as Error).message);
        }
      }
      const settings = connectionModelSettings(resolved.secret, provider, modelId, credential);
      // The account catalog knows what a Codex model reads; elsewhere the model's setting
      // decides wherever the bundled catalog cannot.
      // Live-only models have no static reasoning or context card to fall back to.
      // Keep explicit context limits; enable thinking when the account advertises efforts.
      const acceptsImages = liveCodex?.supportsImages ?? settings.images;
      const accountId = resolved.secret.kind === "api_key" ? resolved.secret.accountId : undefined;
      const gatewayId = resolved.secret.kind === "api_key" ? resolved.secret.gatewayId : undefined;
      cloudflareProviderEnv({ provider, accountId, gatewayId });
      const projectId = resolved.secret.kind === "api_key" ? resolved.secret.projectId : undefined;
      const region = resolved.secret.kind === "api_key" ? resolved.secret.region : undefined;
      const zeroDataRetention =
        resolved.secret.kind === "api_key" ? resolved.secret.zeroDataRetention : undefined;
      return {
        apiKey: resolved.apiKey,
        accountId,
        gatewayId,
        projectId,
        region,
        zeroDataRetention,
        baseUrl,
        apiProtocol:
          resolved.secret.kind === "openai_compatible" ? resolved.secret.apiProtocol : undefined,
        headers: resolved.secret.kind === "openai_compatible" ? resolved.secret.headers : undefined,
        allowPrivateEndpoint,
        cacheCapabilities:
          resolved.secret.kind !== "oauth" ? resolved.secret.cacheCapabilities : undefined,
        contextWindow: settings.contextWindow ?? liveCodex?.contextWindow,
        reasoning: liveCodex?.reasoningEfforts.length ? true : settings.reasoning,
        maxTokens: settings.maxTokens,
        acceptsImages,
        maxImagesPerPrompt: settings.maxImagesPerPrompt,
        oauth,
        persistOAuth: oauth
          ? persistRefreshedModelCredential(
              deps.prisma,
              deps.secretStore,
              { userId, spaceId },
              credential.secretId,
            )
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
  if (requireStoredSecret)
    throw new ModelConnectionGoneError("Backup model credential is no longer available");
  if (modelCreditOfferings() && !operatorFunded) {
    if (!(await modelCreditBillingEnabled(deps)))
      throw new UnavailableModelForAuthError(MISSING_MODEL_RUN_ERROR);
    // Credits a member chose follow the allowlist like their own connections do.
    if (!modelProviderAllowed(modelProviderAllowlist(), provider))
      throw new UnavailableModelForAuthError(MODEL_PROVIDER_NOT_ALLOWED_ERROR);
    const material = await approvedModelCreditMaterial(
      deps.prisma,
      deps.secretStore,
      provider,
      modelId,
    );
    registerSecrets?.(material!.redact);
    return material!;
  }
  cloudflareProviderEnv({ provider });
  return { apiKey: deploymentKeyFor(deps, provider), redact: [] };
}

/** Translate resolved credentials and capabilities consistently for every run path. */
export function resolvedModelRunFields(
  resolved: Awaited<ReturnType<typeof resolveModelKey>>,
): Omit<AgentRunRequest["model"], "provider" | "id" | "thinkingLevel"> {
  return {
    connectionId: resolved.connectionId,
    apiKey: resolved.oauth ? undefined : resolved.apiKey,
    callObserver: resolved.callObserver,
    ...(resolved.accountId ? { accountId: resolved.accountId } : {}),
    ...(resolved.gatewayId ? { gatewayId: resolved.gatewayId } : {}),
    ...(resolved.projectId ? { projectId: resolved.projectId } : {}),
    ...(resolved.region ? { region: resolved.region } : {}),
    ...(resolved.zeroDataRetention ? { zeroDataRetention: true } : {}),
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
  // Before validation, which can probe a stored connection's live catalog: a refused
  // provider is not contacted, and its refusal is not replaced by a failed probe.
  if (!modelProviderAllowed(modelProviderAllowlist(), provider)) {
    throw new UnavailableModelForAuthError(MODEL_PROVIDER_NOT_ALLOWED_ERROR);
  }
  const creditOfferingId = creditOfferingFromConnectionId(credentialId);
  if (creditOfferingId) {
    const resolved = await resolveModelKey(
      deps,
      scope.userId,
      scope.spaceId,
      null,
      provider,
      modelId,
      registerSecrets,
      { creditOfferingId },
    );
    return { credential: null, resolved };
  }
  const hostedProvider = (await modelCreditBillingEnabled(deps))
    ? resolveDeploymentModel().provider
    : undefined;
  const validationError = await validateConnectedModelChoice(
    deps.prisma,
    deps.secretStore,
    scope,
    provider,
    modelId,
    { hostedProvider, credentialId, codexCatalog: deps.codexCatalog },
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
  if (credentialId && !credential) throw new Error(PINNED_PROVIDER_NOT_CONNECTED);
  if (!credential && provider !== hostedProvider && !approvedModelCreditOffering(provider, modelId))
    throw new Error(PINNED_PROVIDER_NOT_CONNECTED);
  const resolved = await resolveModelKey(
    deps,
    scope.userId,
    scope.spaceId,
    credential,
    provider,
    modelId,
    registerSecrets,
    { requireStoredSecret: requireStoredSecret && Boolean(credentialId || credential) },
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
          : null) as AgentRunRequest["model"]["thinkingLevel"]) ?? null,
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
    }),
  ]);
  const selected = selectConfiguredModel({
    override,
    overrideCredential,
    main,
    hostedProvider: (await modelCreditBillingEnabled(deps))
      ? resolveDeploymentModel().provider
      : undefined,
    defaults: {
      settings,
      deployment: deps.deploymentModelConfigured ? resolveDeploymentModel() : null,
    },
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
    undefined,
    {
      creditOfferingId: creditOfferingFromConnectionId(selected.connectionId),
      requireStoredSecret: Boolean(
        selected.connectionId && !creditOfferingFromConnectionId(selected.connectionId),
      ),
    },
  );
  return {
    provider,
    id,
    ...resolvedModelRunFields(resolved),
    thinkingLevel: thinkingLevel ?? null,
  };
}
