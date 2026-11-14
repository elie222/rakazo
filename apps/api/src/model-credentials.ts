import { ORPCError } from "@orpc/server";
import { SecretStoreUnavailableError } from "@rakazo/adapter-kit";
import type { CodexLiveCatalog } from "@rakazo/adapters";
import {
  buildModelConnectPlaintext,
  CHATGPT_OAUTH_PROVIDER,
  codexLiveListsModel,
  compatibleThinkingLevels,
  defaultCatalogModelId,
  enabledOpenAiCompatibleModelIds,
  keptModelSettings,
  listPiCatalog,
  liveCatalogEntry,
  modelCredentialDto,
  parseModelSecret,
  prepareAllowedThinkingLevels as prepareModelThinkingLevels,
  providerCatalogCache,
  resolveCodexOAuthDefaultModel,
  updateStoredModelSecret,
  validateModelAuthAvailability,
  verifyCatalogProviderApiKey,
  verifyOpenAiCompatibleApiKey,
  withModelSettings,
} from "@rakazo/adapters";
import type {
  Actor,
  ModelConnectInput,
  ModelSettingsSave,
  SettingsScope,
  ThinkingLevel,
} from "@rakazo/contracts";
import {
  canonicalPiProviderId,
  MAX_MODEL_SETTINGS_PER_CONNECTION,
  modelOutputLeavesInputRoom,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  storedPiProviderIds,
  usableModelId,
} from "@rakazo/contracts";
import { catalogEntryFor, clampCatalogThinkingLevel, modelSettingsDefaults } from "@rakazo/core";
import {
  deleteUnreferencedCredentialSecret,
  findNewestUserModelCredential,
  getModelRole,
  modelCredentialProviderFilter,
  modelRoleTarget,
  Prisma,
  saveModelPreference,
  withTransactionRetry,
  writeModelRole,
} from "@rakazo/db";
import { mayUsePrivateEndpoint } from "./mcp-servers.js";
import { assertNoDanglingModelPins } from "./model-pins.js";
import type { RouterDeps } from "./router.js";

export function prepareAllowedThinkingLevels(
  deps: RouterDeps,
  actor: Actor,
  provider: string,
  modelId: string,
  resolution?: { credentialId?: string | null },
) {
  return prepareModelThinkingLevels(
    { prisma: deps.prisma, secretStore: deps.secrets },
    actor,
    provider,
    modelId,
    resolution,
  );
}

async function allowedThinkingLevels(
  ...args: Parameters<typeof prepareAllowedThinkingLevels>
): Promise<string[] | undefined> {
  return (await prepareAllowedThinkingLevels(...args)).allowed;
}

/**
 * The connection a save updates: the named one, none for a new one, or the provider's
 * newest for apps that predate several connections per provider.
 */
export async function modelConnectionTarget(
  deps: RouterDeps,
  actor: Actor,
  provider: string,
  credentialId: string | null | undefined,
) {
  if (credentialId === null) return null;
  if (credentialId === undefined)
    return findNewestUserModelCredential(deps.prisma, actor.userId, provider);
  const credential = await deps.prisma.userModelCredential.findFirst({
    where: {
      id: credentialId,
      userId: actor.userId,
      provider: modelCredentialProviderFilter(provider),
    },
  });
  if (!credential) throw new ORPCError("NOT_FOUND", { message: "Connection not found" });
  return credential;
}

/** `base`, or `base 2`, `base 3`… when another connection already has that name. */
export function nextConnectionLabel(base: string, taken: readonly string[]): string {
  const names = new Set(taken.map((label) => label.trim().toLowerCase()));
  if (!names.has(base.toLowerCase())) return base;
  let index = 2;
  while (names.has(`${base} ${index}`.toLowerCase())) index += 1;
  return `${base} ${index}`;
}

type ModelCredentialInput = {
  provider: string;
  /** The connection to update, or null to add one. */
  credentialId: string | null;
  plaintext: string;
  label?: string;
  modelId?: string;
  thinkingLevel?: string | null;
  /** False keeps the current main model. */
  makeDefault?: boolean;
  /** Which copy of the member's models makeDefault sets; omitted means the one that applies. */
  scope?: SettingsScope;
  supportsImages?: boolean;
  signal?: AbortSignal;
  /** Becomes the main model only while there is none. */
  keepExistingDefault?: boolean;
  /** The stored copy whose settings this replacement preserves. */
  expectedSecret?: { id: string; ciphertext: string | null };
};

export async function prepareModelCredential(
  deps: RouterDeps,
  actor: Actor,
  input: ModelCredentialInput,
  codexCatalog: CodexLiveCatalog,
) {
  throwIfAborted(input.signal);
  const parsedSecret = parseModelSecret(input.plaintext);
  const requestedModelId = usableModelId(input.modelId);
  const resolvedCodexModelId =
    canonicalPiProviderId(input.provider) === CHATGPT_OAUTH_PROVIDER &&
    parsedSecret.kind === "oauth"
      ? await resolveCodexOAuthDefaultModel(
          codexCatalog,
          actor.userId,
          parsedSecret,
          requestedModelId,
        )
      : requestedModelId;
  const authError = resolvedCodexModelId
    ? validateModelAuthAvailability(input.provider, resolvedCodexModelId, input.plaintext)
    : undefined;
  // The backend's live catalog can clear a static OAuth exclusion for the
  // account this credential signs into (e.g. Codex Spark on ChatGPT plans).
  if (
    authError &&
    resolvedCodexModelId &&
    !(await codexLiveListsModel(codexCatalog, actor.userId, parsedSecret, resolvedCodexModelId))
  ) {
    throw new ORPCError("BAD_REQUEST", { message: authError });
  }
  const defaultModel =
    resolvedCodexModelId ??
    defaultCatalogModelId(input.provider, input.plaintext) ??
    usableModelId(deps.env.defaultModel);
  // A compatible connect may enable its new default, so judge it by the secret being saved.
  const allowedThinking = !defaultModel
    ? undefined
    : input.provider === OPENAI_COMPATIBLE_PROVIDER_ID
      ? compatibleThinkingLevels(
          { id: "", provider: input.provider, label: "", defaultModel },
          input.plaintext,
          defaultModel,
        ).allowed
      : await allowedThinkingLevels(deps, actor, input.provider, defaultModel);
  const stored = await deps.secrets.put(input.plaintext, {
    operationId: "cred",
    traceId: "cred",
    spaceId: actor.spaceId,
    userId: actor.userId,
    signal: input.signal ?? new AbortController().signal,
  });
  return { stored, defaultModel, allowedThinking };
}

/** Create-only: null when the provider is already connected. */
export async function createImportedModelCredential(
  tx: Prisma.TransactionClient,
  actor: Actor,
  input: ModelCredentialInput,
  prepared: Awaited<ReturnType<typeof prepareModelCredential>>,
) {
  const existing = await tx.userModelCredential.findFirst({
    where: { userId: actor.userId, provider: { in: storedPiProviderIds(input.provider) } },
    select: { id: true },
  });
  if (existing) return null;
  return writeModelCredential(tx, actor, input, prepared);
}

async function writeModelCredential(
  tx: Prisma.TransactionClient,
  actor: Actor,
  input: ModelCredentialInput,
  prepared: Awaited<ReturnType<typeof prepareModelCredential>>,
) {
  const { stored, defaultModel, allowedThinking } = prepared;
  throwIfAborted(input.signal);
  const existing = input.credentialId
    ? await tx.userModelCredential.findFirst({
        where: {
          id: input.credentialId,
          userId: actor.userId,
          provider: { in: storedPiProviderIds(input.provider) },
        },
      })
    : null;
  // A connection removed while this save was in flight stays removed.
  if (input.credentialId && !existing)
    throw new ORPCError("NOT_FOUND", { message: "Connection not found" });
  if (existing && input.expectedSecret) {
    const current = await tx.secret.findFirst({
      where: { id: existing.secretId, userId: actor.userId, spaceId: null },
      select: { ciphertext: true },
    });
    if (
      existing.secretId !== input.expectedSecret.id ||
      (current?.ciphertext ?? null) !== input.expectedSecret.ciphertext
    )
      throw new ORPCError("CONFLICT", { message: "Model credentials changed; retry." });
  }
  throwIfAborted(input.signal);
  const secret = await tx.secret.create({
    data: {
      id: stored.id,
      userId: actor.userId,
      spaceId: null,
      kind: "model",
      ciphertext: stored.ciphertext,
    },
  });
  throwIfAborted(input.signal);
  const credential = !existing
    ? await tx.userModelCredential.create({
        data: {
          userId: actor.userId,
          provider: input.provider,
          label: nextConnectionLabel(
            input.label?.trim() || input.provider,
            (
              await tx.userModelCredential.findMany({
                where: { userId: actor.userId },
                select: { label: true },
              })
            ).map((row) => row.label),
          ),
          secretId: secret.id,
          supportsImages: input.supportsImages ?? false,
        },
      })
    : await tx.userModelCredential.update({
        where: { id: existing.id },
        // A new key or sign-in keeps the connection's name.
        data: {
          secretId: secret.id,
          ...(input.supportsImages !== undefined ? { supportsImages: input.supportsImages } : {}),
        },
      });
  throwIfAborted(input.signal);
  // Connect and limit saves can still carry an effort chosen for the previous
  // model. Keep it only when this model supports it; otherwise clamp or clear.
  const thinkingLevel =
    input.thinkingLevel === undefined
      ? undefined
      : defaultModel
        ? clampCatalogThinkingLevel(input.thinkingLevel, allowedThinking)
        : null;
  const target = await modelRoleTarget(tx, actor, input.scope);
  const mainRole = await getModelRole(tx, target, "main");
  const runsMain = mainRole.primary?.credentialId === credential.id;
  // Only an explicit main-model connect changes a role. Omitted means yes for older apps.
  const becomesMain =
    input.makeDefault !== false &&
    Boolean(defaultModel) &&
    (!input.keepExistingDefault || !mainRole.primary);
  // A main-model connect keeps the effort its model already had.
  const ownThinking = becomesMain
    ? ((
        await writeModelRole(tx, target, "main", {
          primary: {
            provider: input.provider,
            modelId: defaultModel!,
            thinkingLevel: thinkingLevel as ThinkingLevel | null | undefined,
            credentialId: credential.id,
          },
        })
      ).primary?.thinkingLevel ?? null)
    : (thinkingLevel ?? null);
  // The connection's own model; a save for another purpose keeps the one running chat.
  if (becomesMain || !runsMain)
    await saveModelPreference(tx, actor, credential.id, defaultModel, ownThinking);
  throwIfAborted(input.signal);
  if (existing) {
    await deleteUnreferencedCredentialSecret(tx, {
      credentialKind: "model",
      credentialId: existing.id,
      secretId: existing.secretId,
    });
    throwIfAborted(input.signal);
  }
  return { ...credential, isDefault: becomesMain || runsMain, defaultModel };
}

export async function persistModelCredential(
  deps: RouterDeps,
  actor: Actor,
  input: ModelCredentialInput,
  codexCatalog: CodexLiveCatalog,
) {
  const prepared = await prepareModelCredential(deps, actor, input, codexCatalog);
  throwIfAborted(input.signal);
  const cred = await withTransactionRetry(() =>
    deps.prisma.$transaction((tx) => writeModelCredential(tx, actor, input, prepared), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    }),
  );
  (deps.providerCatalog ?? providerCatalogCache).invalidate(canonicalPiProviderId(input.provider));
  return modelCredentialDto(cred, input.plaintext);
}

/** One model's settings on one of the member's connections. */
export async function saveConnectionModelSettings(
  deps: RouterDeps,
  actor: Actor,
  input: ModelSettingsSave,
) {
  const credential = await deps.prisma.userModelCredential.findFirst({
    where: { id: input.credentialId, userId: actor.userId },
    include: { userPreferences: { where: { userId: actor.userId } } },
  });
  if (!credential) throw new ORPCError("NOT_FOUND", { message: "Connection not found" });
  const defaultModel = credential.userPreferences[0]?.modelId;
  const saved = await updateStoredModelSecret(
    deps.prisma,
    deps.secrets,
    actor,
    credential.secretId,
    (secret) => {
      // Clearing a model's settings always works, even after the model left the connection.
      if (
        Object.keys(input.settings).length > 0 &&
        secret.kind === "openai_compatible" &&
        secret.enabledModelIds !== undefined &&
        !enabledOpenAiCompatibleModelIds(secret, defaultModel).includes(input.modelId)
      )
        throw new ORPCError("BAD_REQUEST", { message: "Unknown model for that connection" });
      const defaults = modelSettingsDefaults(
        credential.provider,
        catalogEntryFor(listPiCatalog(), credential.provider, input.modelId) ??
          liveCatalogEntry(credential.provider, input.modelId),
      );
      if (
        (input.settings.maxTokens !== undefined || input.settings.contextWindow !== undefined) &&
        !modelOutputLeavesInputRoom(
          input.settings.maxTokens ?? defaults.maxTokens,
          input.settings.contextWindow ?? defaults.contextWindow,
        )
      )
        throw new ORPCError("BAD_REQUEST", {
          message: "Maximum output tokens must be below the context limit.",
        });
      const next = withModelSettings(secret, input.modelId, input.settings);
      const count = (value: typeof secret) => Object.keys(value.models ?? {}).length;
      if (count(next) > MAX_MODEL_SETTINGS_PER_CONNECTION && count(next) > count(secret))
        throw new ORPCError("BAD_REQUEST", {
          message: "Too many models on this connection have their own settings",
        });
      return next;
    },
  );
  if (!saved) throw new ORPCError("NOT_FOUND", { message: "Connection not found" });
}

/** Keep settings and their source together so a reconnect cannot overwrite a newer save. */
export async function prepareModelReconnectSettings(
  deps: RouterDeps,
  actor: Actor,
  credential: { secretId: string } | null,
) {
  if (!credential) return { settings: {}, expectedSecret: undefined };
  const row = await deps.prisma.secret.findFirst({
    where: { id: credential.secretId, userId: actor.userId, spaceId: null },
    select: { ciphertext: true },
  });
  let settings: ReturnType<typeof keptModelSettings> = {};
  if (row) {
    try {
      settings = keptModelSettings(
        parseModelSecret(await deps.secrets.load(row.ciphertext, credential.secretId)),
      );
    } catch (error) {
      // An outage must not replace settings it could not read; a corrupt copy has none to keep.
      if (error instanceof SecretStoreUnavailableError) throw error;
    }
  }
  return {
    settings,
    expectedSecret: { id: credential.secretId, ciphertext: row?.ciphertext ?? null },
  };
}

export function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason ?? new Error("Request cancelled");
}

export function createModelConnector(deps: RouterDeps, codexCatalog: CodexLiveCatalog) {
  const verifyModelConnection = async (
    actor: Actor,
    input: ModelConnectInput,
    signal: AbortSignal | undefined,
  ) => {
    const credential = await modelConnectionTarget(deps, actor, input.provider, input.credentialId);
    let plaintext: string;
    let expectedSecret: ModelCredentialInput["expectedSecret"];
    try {
      let previousPlaintext: string | undefined;
      let omitVisionModelIds = false;
      if (credential) {
        const secret = await deps.prisma.secret.findFirst({
          where: { id: credential.secretId, userId: actor.userId, spaceId: null },
          select: { ciphertext: true },
        });
        expectedSecret = { id: credential.secretId, ciphertext: secret?.ciphertext ?? null };
        if (secret) {
          try {
            previousPlaintext = await deps.secrets.load(secret.ciphertext, credential.secretId);
          } catch (error) {
            // Explicit key replacement must still succeed when the prior ciphertext is
            // unreadable. Omitting visionModelIds keeps a partial one-model list from
            // wiping other enabled models.
            if (input.apiKey === undefined) throw error;
            if (input.provider === OPENAI_COMPATIBLE_PROVIDER_ID) {
              omitVisionModelIds = true;
            }
          }
        }
      }
      plaintext = buildModelConnectPlaintext(input, previousPlaintext, {
        omitVisionModelIds,
        allowPrivateEndpoint: mayUsePrivateEndpoint(deps),
      });
      if (input.provider === OPENAI_COMPATIBLE_PROVIDER_ID) {
        const saved = parseModelSecret(plaintext);
        if (saved.kind === "openai_compatible") {
          await verifyOpenAiCompatibleApiKey(saved, deps.modelConnectionFetch, signal);
        }
      }
      if (input.apiKey?.trim()) {
        await verifyCatalogProviderApiKey(
          { provider: input.provider, apiKey: input.apiKey },
          deps.modelConnectionFetch,
          signal,
        );
        const saved = parseModelSecret(plaintext);
        const modelId =
          usableModelId(input.modelId) ?? defaultCatalogModelId(input.provider, plaintext);
        if (saved.kind === "api_key" && modelId && deps.modelConnectionCheck) {
          await deps.modelConnectionCheck(
            {
              provider: input.provider,
              id: modelId,
              apiKey: saved.key,
              accountId: saved.accountId,
              gatewayId: saved.gatewayId,
              maxTokens: saved.maxTokens,
            },
            { fetch: deps.modelConnectionFetch, signal },
          );
        }
      }
    } catch (error) {
      throw new ORPCError("BAD_REQUEST", {
        message: error instanceof Error ? error.message : "Invalid model connection",
      });
    }
    if (input.provider === OPENAI_COMPATIBLE_PROVIDER_ID) {
      // Known race: this runs before persistModelCredential's transaction, so a pin saved in
      // between can fall outside the stored list and fail at run time. Concurrent saves of
      // the same connection are rejected when their source secret changes.
      const saved = parseModelSecret(plaintext);
      if (credential)
        await assertNoDanglingModelPins(deps, actor, credential, saved, input.modelId ?? "");
    }
    return { plaintext, credential, expectedSecret };
  };
  const connectModelCredential = async (
    actor: Actor,
    input: ModelConnectInput,
    signal: AbortSignal | undefined,
  ) => {
    const { plaintext, credential, expectedSecret } = await verifyModelConnection(
      actor,
      input,
      signal,
    );
    return persistModelCredential(
      deps,
      actor,
      {
        provider: input.provider,
        credentialId: credential?.id ?? null,
        plaintext,
        expectedSecret,
        label: input.label,
        modelId: input.modelId,
        // openai-compatible keeps its effort inside the stored endpoint
        // secret; catalog providers store it on the space preference.
        thinkingLevel:
          input.provider === OPENAI_COMPATIBLE_PROVIDER_ID ? undefined : input.thinkingLevel,
        makeDefault: input.makeDefault,
        scope: input.scope,
        supportsImages: input.supportsImages,
        signal,
      },
      codexCatalog,
    );
  };
  return { verifyModelConnection, connectModelCredential };
}
