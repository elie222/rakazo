import { ORPCError } from "@orpc/server";
import type { SecretStore } from "@rakazo/adapter-kit";
import type { DeploymentModels, SavedDeploymentModels } from "@rakazo/adapters";
import {
  allowlistOpens,
  allowlistWithProvider,
  buildModelConnectPlaintext,
  DEPLOYMENT_MODEL_SETTINGS,
  defaultCatalogModelId,
  defaultOnlyDeploymentModels,
  deploymentConnectableProviders,
  deploymentConnectionModels,
  deploymentConnectionRecord,
  describeDeploymentConnection,
  loadDeploymentModels,
  parseModelAllowlist,
  parseModelSecret,
  probeOpenAiCompatibleModels,
  storedOpenAiCompatibleProbeKey,
  verifyCatalogProviderApiKey,
  verifyOpenAiCompatibleApiKey,
} from "@rakazo/adapters";
import type {
  Actor,
  DeploymentModelConnect,
  DeploymentModelSettings,
  DeploymentModelUpdate,
} from "@rakazo/contracts";
import { canonicalPiProviderId, OPENAI_COMPATIBLE_PROVIDER_ID } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { Prisma, runAsSystem, withTransactionRetry } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { requireAdmin } from "./admins.js";
import type { RouterDeps } from "./router.js";

type ModelEnv = Pick<
  RouterDeps["env"],
  | "defaultProvider"
  | "defaultModel"
  | "deploymentModelConfigured"
  | "deploymentModelHostCredentials"
  | "deploymentModels"
>;

export interface DeploymentModelDeps {
  prisma: PrismaClient;
  secrets: Pick<SecretStore, "put" | "load" | "delete">;
  env: ModelEnv & Pick<RouterDeps["env"], "adminEmails" | "mcpAllowPrivateEndpoint">;
  modelConnectionFetch?: RouterDeps["modelConnectionFetch"];
  modelConnectionCheck?: RouterDeps["modelConnectionCheck"];
}

/** The deployment's models as this process read them from its environment. */
function environmentModels(env: ModelEnv): DeploymentModels {
  return (
    env.deploymentModels ??
    defaultOnlyDeploymentModels({
      provider: env.defaultProvider,
      model: env.defaultModel,
      key: undefined,
      configured: Boolean(env.deploymentModelConfigured),
      hostCredentials: Boolean(env.deploymentModelHostCredentials),
    })
  );
}

/**
 * The deployment's models now: the environment's with an admin's settings applied, read at use
 * time so every instance follows a change without a restart. Pass the settings row when it is
 * already loaded. The API never needs a key itself.
 */
export function currentDeploymentModels(
  deps: {
    prisma: PrismaClient;
    env: ModelEnv;
    billing?: Pick<NonNullable<RouterDeps["billing"]>, "modelCreditsEnabled">;
  },
  saved?: SavedDeploymentModels | null,
): Promise<DeploymentModels> {
  // Hosted credits keep serving members exactly as before deployment models.
  return loadDeploymentModels(deps.prisma, environmentModels(deps.env), saved, {
    creditsOnly: deps.billing?.modelCreditsEnabled || undefined,
  });
}

const VERIFY_TIMEOUT_MS = 20_000;

function readSaved(prisma: PrismaClient) {
  return runAsSystem("read the deployment's models", () =>
    prisma.deploymentSettings.findUnique({
      where: { id: "default" },
      include: DEPLOYMENT_MODEL_SETTINGS,
    }),
  );
}

/** A saved OpenAI-compatible endpoint's settings; unreadable ones show without them. */
async function savedEndpoint(deps: DeploymentModelDeps, row: { ciphertext: string }) {
  try {
    const secret = parseModelSecret(
      await deps.secrets.load(
        row.ciphertext,
        deploymentConnectionRecord(OPENAI_COMPATIBLE_PROVIDER_ID),
      ),
    );
    return secret.kind === "openai_compatible" ? secret : undefined;
  } catch {
    return undefined;
  }
}

async function view(deps: DeploymentModelDeps): Promise<DeploymentModelSettings> {
  const saved = await readSaved(deps.prisma);
  const rows = saved?.modelConnections ?? [];
  const models = await currentDeploymentModels(deps, saved);
  const savedProviders = new Set(rows.map((row) => row.provider));
  const compatible = rows.find((row) => row.provider === OPENAI_COMPATIBLE_PROVIDER_ID);
  const endpoint = compatible ? await savedEndpoint(deps, compatible) : undefined;
  const choice = (provider: string | null | undefined, modelId: string | null | undefined) =>
    provider && modelId ? { provider, modelId } : null;
  return {
    defaultModel: choice(saved?.defaultModelProvider, saved?.defaultModelId),
    effectiveDefault: models.default.configured
      ? choice(models.default.provider, models.default.model)
      : null,
    allowedModels: saved?.allowedModels != null ? parseModelAllowlist(saved.allowedModels) : null,
    effectiveAllowedModels: models.allowed,
    connections: models.connections.map((connection) => ({
      provider: connection.provider,
      ...describeDeploymentConnection(connection),
      saved: savedProviders.has(connection.provider),
      open: allowlistOpens(models.allowed, connection.provider),
      ...(connection.provider === OPENAI_COMPATIBLE_PROVIDER_ID && endpoint
        ? {
            baseUrl: endpoint.baseUrl,
            ...(endpoint.contextWindow ? { contextWindow: endpoint.contextWindow } : {}),
            ...(endpoint.maxTokens ? { maxTokens: endpoint.maxTokens } : {}),
          }
        : {}),
    })),
    providers: deploymentConnectableProviders(),
  };
}

export async function getDeploymentModelSettings(
  deps: DeploymentModelDeps,
  actor: Actor,
): Promise<DeploymentModelSettings> {
  await requireAdmin(deps, actor.userId);
  return view(deps);
}

/** Saves the default model and the allowlist; null for either follows the environment again. */
export async function updateDeploymentModelSettings(
  deps: DeploymentModelDeps,
  actor: Actor,
  input: DeploymentModelUpdate,
): Promise<DeploymentModelSettings> {
  await requireAdmin(deps, actor.userId);
  const data: Omit<SavedDeploymentModels, "modelConnections"> = {};
  if (input.defaultModel !== undefined) {
    const choice = input.defaultModel;
    if (choice) {
      // Only a model one of the deployment's connections runs can be everyone's default.
      const models = await currentDeploymentModels(deps);
      const connection = models.connections.find(
        (entry) => canonicalPiProviderId(entry.provider) === canonicalPiProviderId(choice.provider),
      );
      if (!connection || !deploymentConnectionModels(connection).includes(choice.modelId))
        throw new ORPCError("BAD_REQUEST", { message: "Connect that model provider first" });
    }
    data.defaultModelProvider = choice ? canonicalPiProviderId(choice.provider) : null;
    data.defaultModelId = choice?.modelId ?? null;
  }
  if (input.allowedModels !== undefined)
    data.allowedModels =
      input.allowedModels === null
        ? null
        : parseModelAllowlist(input.allowedModels.join(",")).join(",");
  if (input.open) {
    // A switch opens or closes one connection; the list it edits is the one in effect.
    const models = await currentDeploymentModels(deps);
    const allowed =
      typeof data.allowedModels === "string"
        ? parseModelAllowlist(data.allowedModels)
        : models.allowed;
    data.allowedModels = allowlistWithProvider(
      allowed,
      models.connections.map((connection) => connection.provider),
      input.open.provider,
      input.open.open,
    ).join(",");
  }
  await runAsSystem("an admin sets the deployment's models", () =>
    deps.prisma.deploymentSettings.upsert({
      where: { id: "default" },
      create: { id: "default", ...data },
      update: data,
    }),
  );
  return view(deps);
}

/** Builds and checks a connection the way connecting an own model does, before it is saved. */
async function checkedConnection(
  deps: DeploymentModelDeps,
  actor: Actor,
  input: DeploymentModelConnect,
  previous: string | undefined,
  signal: AbortSignal,
): Promise<{ plaintext: string; models: string[] }> {
  try {
    if (input.provider === OPENAI_COMPATIBLE_PROVIDER_ID) {
      const enabledModelIds = [...new Set(input.enabledModelIds ?? [])];
      const plaintext = buildModelConnectPlaintext(
        {
          provider: OPENAI_COMPATIBLE_PROVIDER_ID,
          credentialId: null,
          baseUrl: input.baseUrl,
          // Blank keeps the saved key while the URL stays the same.
          apiKey: input.apiKey || undefined,
          modelId: enabledModelIds[0],
          enabledModelIds,
          contextWindow: input.contextWindow,
          maxTokens: input.maxTokens,
        },
        previous,
        { allowPrivateEndpoint: deps.env.mcpAllowPrivateEndpoint === true },
      );
      const secret = parseModelSecret(plaintext);
      if (secret.kind === "openai_compatible")
        await verifyOpenAiCompatibleApiKey(secret, deps.modelConnectionFetch, signal);
      return { plaintext, models: enabledModelIds };
    }
    if (!deploymentConnectableProviders().some((provider) => provider.id === input.provider))
      throw new Error("Unknown model provider");
    const apiKey = input.apiKey;
    if (!apiKey) throw new Error("Enter an API key");
    await verifyCatalogProviderApiKey(
      { provider: input.provider, apiKey },
      deps.modelConnectionFetch,
      signal,
    );
    const modelId = defaultCatalogModelId(input.provider, apiKey);
    if (modelId)
      await deps.modelConnectionCheck?.(
        { provider: input.provider, id: modelId, apiKey },
        { fetch: deps.modelConnectionFetch, signal },
      );
    return { plaintext: apiKey, models: [] };
  } catch (error) {
    // Provider errors can echo the request; log only the error's class.
    getLogger().warn("deployment_model.verify_failed", {
      provider: input.provider,
      "user.id": actor.userId,
      "error.name": error instanceof Error ? error.name : typeof error,
    });
    throw new ORPCError("BAD_REQUEST", {
      message: error instanceof Error ? error.message : "Invalid model connection",
    });
  }
}

/** Connects a provider for the whole deployment, or replaces its saved connection. */
export async function connectDeploymentModel(
  deps: DeploymentModelDeps,
  actor: Actor,
  input: DeploymentModelConnect,
  signal?: AbortSignal,
): Promise<DeploymentModelSettings> {
  await requireAdmin(deps, actor.userId);
  const provider = canonicalPiProviderId(input.provider);
  const record = deploymentConnectionRecord(provider);
  const existing = await runAsSystem("read a deployment model connection", () =>
    deps.prisma.deploymentModelConnection.findUnique({ where: { provider } }),
  );
  // A blank key keeps a saved provider key as it is.
  if (existing && provider !== OPENAI_COMPATIBLE_PROVIDER_ID && !input.apiKey) return view(deps);
  const previous = existing
    ? await deps.secrets.load(existing.ciphertext, record).catch(() => undefined)
    : undefined;
  const checkSignal = AbortSignal.any([
    AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    ...(signal ? [signal] : []),
  ]);
  const { plaintext, models } = await checkedConnection(
    deps,
    actor,
    { ...input, provider },
    previous,
    checkSignal,
  );
  // Owned by the deployment, not a user or space, so no account deletion removes it.
  const stored = await deps.secrets.put(
    plaintext,
    {
      operationId: "deployment-model",
      traceId: "deployment-model",
      spaceId: actor.spaceId,
      userId: actor.userId,
      signal: signal ?? new AbortController().signal,
    },
    { recordId: record },
  );
  let replaced: string | undefined;
  try {
    // Read what this save replaces in the same transaction, so concurrent saves each remove theirs.
    replaced = await withTransactionRetry(() =>
      runAsSystem("an admin connects a deployment model provider", () =>
        deps.prisma.$transaction(
          async (tx) => {
            const current = await tx.deploymentModelConnection.findUnique({
              where: { provider },
              select: { ciphertext: true },
            });
            // The connection belongs to the deployment's settings row.
            await tx.deploymentSettings.upsert({
              where: { id: "default" },
              create: { id: "default" },
              update: {},
            });
            await tx.deploymentModelConnection.upsert({
              where: { provider },
              create: { provider, ciphertext: stored.ciphertext, models },
              update: { ciphertext: stored.ciphertext, models },
            });
            // A saved default the endpoint no longer lists goes, so the environment's applies.
            if (models.length)
              await tx.deploymentSettings.updateMany({
                where: {
                  id: "default",
                  defaultModelProvider: provider,
                  defaultModelId: { notIn: models },
                },
                data: { defaultModelProvider: null, defaultModelId: null },
              });
            return current?.ciphertext;
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        ),
      ),
    );
  } catch (error) {
    await deps.secrets.delete(stored.ciphertext, record).catch(() => undefined);
    throw error;
  }
  // A secret store keeps every saved value until it is deleted there too.
  if (replaced && replaced !== stored.ciphertext)
    await deps.secrets.delete(replaced, record).catch(() => undefined);
  return view(deps);
}

/** Removes a saved connection; the environment's for the provider, if any, applies again. */
export async function disconnectDeploymentModel(
  deps: DeploymentModelDeps,
  actor: Actor,
  input: { provider: string },
): Promise<DeploymentModelSettings> {
  await requireAdmin(deps, actor.userId);
  const provider = canonicalPiProviderId(input.provider);
  // A default only this connection ran goes with it, so everyone falls back to the environment's.
  const keepsDefault = environmentModels(deps.env).connections.some(
    (connection) => canonicalPiProviderId(connection.provider) === provider,
  );
  const removed = await runAsSystem("an admin removes a deployment model provider", () =>
    deps.prisma.$transaction(async (tx) => {
      const current = await tx.deploymentModelConnection.findUnique({ where: { provider } });
      if (current) await tx.deploymentModelConnection.delete({ where: { provider } });
      if (!keepsDefault)
        await tx.deploymentSettings.updateMany({
          where: { id: "default", defaultModelProvider: provider },
          data: { defaultModelProvider: null, defaultModelId: null },
        });
      return current?.ciphertext;
    }),
  );
  if (removed)
    await deps.secrets.delete(removed, deploymentConnectionRecord(provider)).catch(() => undefined);
  return view(deps);
}

/** An OpenAI-compatible endpoint's models, for an admin choosing which ones to offer. */
export async function probeDeploymentModels(
  deps: DeploymentModelDeps,
  actor: Actor,
  input: { baseUrl: string; apiKey: string },
  signal?: AbortSignal,
): Promise<{ models: string[] }> {
  await requireAdmin(deps, actor.userId);
  let apiKey = input.apiKey || undefined;
  if (!apiKey) {
    const saved = await runAsSystem("read a deployment model connection", () =>
      deps.prisma.deploymentModelConnection.findUnique({
        where: { provider: OPENAI_COMPATIBLE_PROVIDER_ID },
      }),
    );
    if (saved)
      apiKey = storedOpenAiCompatibleProbeKey(
        input.baseUrl,
        await deps.secrets
          .load(saved.ciphertext, deploymentConnectionRecord(OPENAI_COMPATIBLE_PROVIDER_ID))
          .catch(() => undefined),
      );
  }
  try {
    const models = await probeOpenAiCompatibleModels(
      { baseUrl: input.baseUrl, apiKey },
      deps.modelConnectionFetch,
      signal,
      { allowPrivate: deps.env.mcpAllowPrivateEndpoint === true },
    );
    return { models };
  } catch (error) {
    throw new ORPCError("BAD_REQUEST", {
      message: error instanceof Error ? error.message : "Could not list models",
    });
  }
}
