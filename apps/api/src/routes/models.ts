import { ORPCError } from "@orpc/server";
import {
  isSignInRetryRequest,
  isTransientModelError,
  SecretStoreUnavailableError,
} from "@rakazo/adapter-kit";
import type { CatalogReads, PiOAuthPersist } from "@rakazo/adapters";
import {
  assertModelProviderAllowed,
  compatibleEndpointPreset,
  listModelCredentials,
  listPiCatalog,
  ModelSignInError,
  mediaModelsView,
  oauthCredentialEmail,
  prepareStoredModelAuth,
  probeCatalogProviderModels,
  probeOpenAiCompatibleModels,
  providerCatalogCache,
  selectDefaultCredentialId,
  serializeModelSecret,
  setMediaModel,
  storedOpenAiCompatibleProbeHeaders,
  storedOpenAiCompatibleProbeKey,
  subscriptionSignInChoice,
  UNAVAILABLE_MODEL_FOR_AUTH_MESSAGE,
} from "@rakazo/adapters";
import type { Actor, ModelCredential, ThinkingLevel } from "@rakazo/contracts";
import {
  backupChoiceKey,
  ConnectionSetupError,
  canonicalPiProviderId,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  usableModelId,
} from "@rakazo/contracts";
import { ClientError, clampCatalogThinkingLevel } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import {
  appliedModelRole,
  defaultModelCredentialCandidates,
  deleteUnreferencedCredentialSecret,
  deploymentModelChangesScope,
  findModelCredential,
  getModelRole,
  modelCredentialProviderFilter,
  modelRoleTarget,
  Prisma,
  runAsSystemInTransaction,
  saveModelPreference,
  updateModelRole,
  withTransactionRetry,
  writeModelRole,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { markExpectedFailure } from "@rakazo/logging/hono";
import {
  assertCompatibleDefaultChange,
  disconnectedModelChoices,
  modelDisconnectPreview,
} from "../bots/model-pins.js";
import { mayUsePrivateEndpoint } from "../integrations/mcp-servers.js";
import {
  getDeploymentModelSettings,
  updateDeploymentModelSettings,
} from "../models/deployment-model-settings.js";
import {
  recordSignInStep,
  signInDurationMs,
  signInFlow,
  signInRecorder,
  startModelConnect,
} from "../models/model-connect-analytics.js";
import {
  modelConnectionErrorMessage,
  modelConnectionTarget,
  persistModelCredential,
  prepareAllowedThinkingLevels,
  prepareModelReconnectSettings,
  saveConnectionModelSettings,
  throwIfAborted,
} from "../models/model-credentials.js";
import type { RouterContext } from "./context.js";

/** A secret store outage is answered as one the member waits out; any other failure is unchanged. */
function secretStoreOutage(error: unknown): unknown {
  return error instanceof SecretStoreUnavailableError
    ? new ClientError("SERVICE_UNAVAILABLE", "Service Unavailable", undefined, { cause: error })
    : error;
}

/** What a probe found wrong with the server or its details is the member's to fix. */
function probeRefusal(
  error: unknown,
  attempted: { apiKey?: string; headers?: Record<string, string> },
): unknown {
  return error instanceof ConnectionSetupError
    ? new ClientError(
        "BAD_REQUEST",
        modelConnectionErrorMessage(error, "Could not list models", attempted),
      )
    : error;
}

export function modelsRoutes(ctx: RouterContext) {
  const {
    deps,
    codexCatalog,
    connectModelCredential,
    refreshExpiredCredential,
    chatCatalog,
    withServingConnections,
    deploymentDefault,
    withImageInput,
    modelRoleCatalog,
    validateRoleChoices,
    authed,
  } = ctx;
  const saveSignIn =
    (actor: Actor): PiOAuthPersist<ModelCredential> =>
    async (login) => {
      try {
        const record = signInRecorder(deps.analytics, actor.userId, login.measure);
        const target = await modelConnectionTarget(deps, actor, login.provider, login.credentialId);
        const retained = await prepareModelReconnectSettings(deps, actor, target);
        const choice = target
          ? { modelId: login.modelId, thinkingLevel: login.thinkingLevel }
          : subscriptionSignInChoice(login.provider, login.modelId, login.thinkingLevel);
        const saved = await persistModelCredential(
          deps,
          actor,
          {
            provider: login.provider,
            credentialId: target?.id ?? null,
            plaintext: serializeModelSecret({
              kind: "oauth",
              credential: login.credential,
              ...retained.settings,
            }),
            expectedSecret: retained.expectedSecret,
            // A second account is told apart by the email it signed in with.
            label:
              oauthCredentialEmail(login.credential) ??
              login.label ??
              listPiCatalog().find((entry) => entry.provider === login.provider)?.providerName,
            modelId: choice.modelId,
            thinkingLevel: choice.thinkingLevel,
            makeDefault: login.makeDefault,
            scope: login.settingsScope,
            signal: login.signal,
          },
          codexCatalog,
        );
        record(login.provider, {
          name: "model_connected",
          ...(login.mode ? { flow: signInFlow(login.mode) } : {}),
          ...(login.startedAt ? { durationMs: signInDurationMs(login.startedAt) } : {}),
        });
        return saved;
      } catch (error) {
        // The member is told why a save was refused; anything else is reported generically.
        if (error instanceof ORPCError) throw new ModelSignInError(error.message);
        throw error;
      }
    };
  return {
    models: {
      list: authed.models.list.handler(async ({ context }) =>
        withServingConnections(context.actor, await chatCatalog(context.actor)),
      ),
      credentials: authed.models.credentials.handler(async ({ context }) => {
        try {
          return await listModelCredentials(
            { prisma: deps.prisma, secretStore: deps.secrets },
            context.actor,
            { showMainModel: true },
          );
        } catch (error) {
          throw secretStoreOutage(error);
        }
      }),
      forRole: authed.models.forRole.handler(async ({ context, input }) =>
        modelRoleCatalog(context.actor, input.role),
      ),
      role: authed.models.role.handler(async ({ context, input }) => {
        if (input.expectedUserId && input.expectedUserId !== context.actor.userId)
          throw new ORPCError("FORBIDDEN");
        const { actor } = context;
        const { role, scope } = input;
        const [settings, deployment] = await Promise.all([
          modelRoleTarget(deps.prisma, actor, scope).then((target) =>
            getModelRole(deps.prisma, target, role),
          ),
          deploymentDefault(actor, role),
        ]);
        return withImageInput(actor, role, { ...settings, ...deployment });
      }),
      setRole: authed.models.setRole.handler(async ({ context, input }) => {
        if (input.expectedUserId && input.expectedUserId !== context.actor.userId)
          throw new ORPCError("FORBIDDEN");
        const { role, primary, backups, scope } = input;
        const reads: CatalogReads = new Map();
        await validateRoleChoices(
          context.actor,
          role,
          [...(primary ? [primary] : []), ...(backups ?? [])],
          reads,
        );
        const deployment = await deploymentDefault(context.actor, role);
        const settings = await updateModelRole(
          deps.prisma,
          { userId: context.actor.userId, spaceId: context.actor.spaceId, scope },
          role,
          { primary, backups },
        );
        return withImageInput(context.actor, role, { ...settings, ...deployment }, reads);
      }),
      media: authed.models.media.handler(async ({ context, input }) => {
        if (input.expectedUserId && input.expectedUserId !== context.actor.userId)
          throw new ORPCError("FORBIDDEN");
        const target = await modelRoleTarget(deps.prisma, context.actor, input.scope);
        return mediaModelsView(deps.prisma, target);
      }),
      setMedia: authed.models.setMedia.handler(async ({ context, input }) => {
        if (input.expectedUserId && input.expectedUserId !== context.actor.userId)
          throw new ORPCError("FORBIDDEN");
        const { actor } = context;
        const { role, credentialId, modelId, scope } = input;
        await setMediaModel(
          deps.prisma,
          { userId: actor.userId, spaceId: actor.spaceId, scope },
          role,
          { credentialId, modelId },
        );
        return mediaModelsView(deps.prisma, await modelRoleTarget(deps.prisma, actor, scope));
      }),
      backups: authed.models.backups.handler(async ({ context }) =>
        (await appliedModelRole(deps.prisma, context.actor, "main")).backups.map(
          ({ provider, modelId, credentialId, creditOfferingId }) => ({
            provider,
            modelId,
            ...(credentialId ? { credentialId } : {}),
            ...(creditOfferingId ? { creditOfferingId } : {}),
          }),
        ),
      ),
      setBackups: authed.models.setBackups.handler(async ({ context, input }) => {
        const previous = (await appliedModelRole(deps.prisma, context.actor, "main")).backups;
        const backups = input.map((choice) => {
          if (choice.credentialId || choice.creditOfferingId) return choice;
          const matches = previous.filter(
            (saved) => backupChoiceKey(saved) === backupChoiceKey(choice),
          );
          if (matches.length > 1)
            throw new ClientError("CONFLICT", "Choose one funding connection");
          const saved = matches[0];
          return {
            ...choice,
            ...(saved?.credentialId ? { credentialId: saved.credentialId } : {}),
            ...(saved?.creditOfferingId ? { creditOfferingId: saved.creditOfferingId } : {}),
          };
        });
        await validateRoleChoices(context.actor, "main", backups);
        await updateModelRole(
          deps.prisma,
          { userId: context.actor.userId, spaceId: context.actor.spaceId },
          "main",
          { backups },
        );
        return { ok: true as const };
      }),
      connect: authed.models.connect.handler(async ({ context, input }) => {
        const { record } = await startModelConnect(deps, context.actor, "api_key", input.provider, {
          surface: input.surface,
          appVersion: input.appVersion,
        });
        try {
          const saved = await connectModelCredential(context.actor, input, context.signal);
          record(input.provider, { name: "model_connected" });
          return saved;
        } catch (error) {
          record(input.provider, { name: "model_connect_failed", error });
          throw error;
        }
      }),
      probeOpenAiCompatible: authed.models.probeOpenAiCompatible.handler(
        async ({ context, input }) => {
          assertModelProviderAllowed(OPENAI_COMPATIBLE_PROVIDER_ID);
          const preset = compatibleEndpointPreset(input.baseUrl);
          let apiKey = input.apiKey;
          let headers = input.headers;
          if (!preset?.publicModels && (!apiKey?.trim() || headers === undefined)) {
            try {
              const preferred = await findModelCredential(
                deps.prisma,
                context.actor,
                OPENAI_COMPATIBLE_PROVIDER_ID,
              );
              const credentials = await deps.prisma.userModelCredential.findMany({
                where: { userId: context.actor.userId, provider: OPENAI_COMPATIBLE_PROVIDER_ID },
                orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
              });
              const candidates = input.credentialId
                ? credentials.filter((credential) => credential.id === input.credentialId)
                : preferred
                  ? [
                      preferred,
                      ...credentials.filter((credential) => credential.id !== preferred.id),
                    ]
                  : credentials;
              const secrets = await deps.prisma.secret.findMany({
                where: {
                  id: { in: candidates.map((credential) => credential.secretId) },
                  userId: context.actor.userId,
                  spaceId: null,
                },
                select: { id: true, ciphertext: true },
              });
              const ciphertexts = new Map(secrets.map((secret) => [secret.id, secret.ciphertext]));
              for (const credential of candidates) {
                const ciphertext = ciphertexts.get(credential.secretId);
                if (!ciphertext) continue;
                try {
                  const plaintext = await deps.secrets.load(ciphertext, credential.secretId);
                  const savedKey = storedOpenAiCompatibleProbeKey(input.baseUrl, plaintext);
                  const savedHeaders = storedOpenAiCompatibleProbeHeaders(input.baseUrl, plaintext);
                  if (!savedKey && savedHeaders === undefined) continue;
                  // A saved key and its routing headers are one credential. Explicit
                  // replacements may override either field, but never borrow from another row.
                  if (!apiKey?.trim()) apiKey = savedKey;
                  headers ??= savedHeaders;
                  break;
                } catch {
                  // An unreadable secret must not prevent trying the remaining credentials.
                }
              }
            } catch {
              // An unavailable saved key must not prevent a keyless probe.
            }
          }
          try {
            const models = await probeOpenAiCompatibleModels(
              { ...input, apiKey, headers },
              preset ? deps.modelConnectionFetch : undefined,
              context.signal,
              { allowPrivate: mayUsePrivateEndpoint(deps), catalogProbe: preset !== undefined },
            );
            return { models };
          } catch (error) {
            throw probeRefusal(error, { apiKey, headers });
          }
        },
      ),
      probeCatalog: authed.models.probeCatalog.handler(async ({ context, input }) => {
        assertModelProviderAllowed(input.provider);
        try {
          const models = await probeCatalogProviderModels(
            { provider: input.provider, apiKey: input.apiKey },
            deps.modelConnectionFetch,
            context.signal,
          );
          return { models };
        } catch (error) {
          throw probeRefusal(error, input);
        }
      }),
      beginOAuth: authed.models.beginOAuth.handler(async ({ context, input }) => {
        assertModelProviderAllowed(input.provider);
        // An older app's sign-in renews the provider's newest connection, bound now so a
        // disconnect of that connection retires it and it never lands on another one.
        const target = await modelConnectionTarget(
          deps,
          context.actor,
          input.provider,
          input.credentialId,
        );
        const { record, measure } = await startModelConnect(
          deps,
          context.actor,
          "oauth",
          input.provider,
          { surface: input.surface, appVersion: input.appVersion },
        );
        const startedAt = new Date();
        return deps.oauthLogins
          .begin({
            userId: context.actor.userId,
            spaceId: context.actor.spaceId,
            provider: input.provider,
            credentialId: target?.id ?? null,
            modelId: input.modelId,
            thinkingLevel: input.thinkingLevel,
            makeDefault: input.makeDefault,
            settingsScope: input.scope,
            label: input.label,
            codePage: input.codePage,
            measure,
            signal: context.signal,
            persist: saveSignIn(context.actor),
          })
          .then((started) => {
            recordSignInStep(
              deps.analytics,
              {
                userId: context.actor.userId,
                provider: input.provider,
                mode: started.mode,
                startedAt,
                measure,
              },
              "code_issued",
            );
            return started;
          })
          .catch((error: unknown) => {
            record(input.provider, { name: "model_connect_failed", error });
            // The provider's sign-in service is down or overloaded; the user tries again later.
            if (isTransientModelError(error) || isSignInRetryRequest(error)) {
              getLogger().warn("rpc models/beginOAuth provider unavailable", {
                reason: error instanceof Error ? error.message : String(error),
              });
              markExpectedFailure();
              throw new ClientError("SERVICE_UNAVAILABLE", "Service Unavailable", undefined, {
                cause: error,
              });
            }
            throw error;
          });
      }),
      submitOAuthCode: authed.models.submitOAuthCode.handler(async ({ context, input }) => {
        return deps.oauthLogins
          .submit(input.loginId, context.actor, input.code, saveSignIn(context.actor))
          .catch((error: unknown) => {
            if (error instanceof ModelSignInError)
              throw new ClientError("BAD_REQUEST", error.message);
            throw error;
          });
      }),
      completeOAuth: authed.models.completeOAuth.handler(async ({ context, input }) => {
        const result = await deps.oauthLogins.complete(input.loginId, context.actor);
        // The sign-in already reported how it ended, as model_connect_ended.
        if (result.status === "error") return { status: "error" as const, error: result.error };
        return result.status === "connected" ? { status: "ready" as const } : result;
      }),
      finishOAuth: authed.models.finishOAuth.handler(async ({ context, input }) => {
        throwIfAborted(context.signal);
        const result = await deps.oauthLogins.finish(input.loginId, context.actor);
        if (result.status === "pending") {
          throw new ORPCError("CONFLICT", { message: "Sign-in has not finished yet." });
        }
        if (result.status === "error") throw new ORPCError("NOT_FOUND", { message: result.error });
        // The save already counted the connection.
        return result.value;
      }),
      cancelOAuth: authed.models.cancelOAuth.handler(async ({ context, input }) => {
        await deps.oauthLogins.cancel(input.loginId, context.actor, input.reason);
        return { ok: true as const };
      }),
      setDefault: authed.models.setDefault.handler(async ({ context, input }) => {
        assertModelProviderAllowed(input.provider);
        const modelId = usableModelId(input.modelId);
        if (!modelId) throw new ORPCError("BAD_REQUEST", { message: "Choose a model" });
        // An omitted level keeps the one this model already has in the main list: on the
        // chosen connection first, then on another, as writeModelRole does.
        const savedChoices = async (
          client: Pick<
            PrismaClient,
            "spaceModelRoleChoice" | "userModelRoleChoice" | "spaceSettingOverride"
          >,
        ) => {
          const main = await appliedModelRole(client, context.actor, "main");
          const key = backupChoiceKey({ provider: input.provider, modelId });
          return [...(main.primary ? [main.primary] : []), ...main.backups].filter(
            (choice) => backupChoiceKey(choice) === key,
          );
        };
        const loadModelState = async (
          client: Pick<PrismaClient, "userModelPreference" | "userModelCredential">,
        ) => {
          const [preferences, credentials] = await Promise.all([
            client.userModelPreference.findMany({
              where: {
                userId: context.actor.userId,
                credential: { provider: modelCredentialProviderFilter(input.provider) },
              },
              include: { credential: true },
            }),
            client.userModelCredential.findMany({
              where: {
                userId: context.actor.userId,
                provider: modelCredentialProviderFilter(input.provider),
              },
            }),
          ]);
          return {
            preferences,
            candidates: defaultModelCredentialCandidates({
              provider: input.provider,
              modelId: input.modelId,
              preferences,
              credentials,
            }),
          };
        };
        await withTransactionRetry(async () => {
          const preparedState = await loadModelState(deps.prisma);
          const preparedAuth = new Map(
            await Promise.all(
              preparedState.candidates.map(
                async (candidate) =>
                  [
                    candidate.secretId,
                    await prepareStoredModelAuth(
                      deps.prisma,
                      deps.secrets,
                      context.actor.userId,
                      candidate.secretId,
                      input.provider,
                      input.modelId,
                      codexCatalog,
                      {
                        onExpiredToken: () =>
                          refreshExpiredCredential(
                            context.actor,
                            candidate.secretId,
                            input.provider,
                          ),
                      },
                    ),
                  ] as const,
              ),
            ),
          );
          const needsThinking =
            input.thinkingLevel === undefined
              ? (await savedChoices(deps.prisma)).some((choice) => Boolean(choice.thinkingLevel))
              : Boolean(input.thinkingLevel);
          const compatible = input.provider === OPENAI_COMPATIBLE_PROVIDER_ID;
          // Compatible defaults always load the secret so the transaction rechecks it.
          const thinking =
            needsThinking || compatible
              ? await prepareAllowedThinkingLevels(
                  deps,
                  context.actor,
                  input.provider,
                  input.modelId,
                )
              : { allowed: undefined, secret: undefined };
          if (compatible) {
            await assertCompatibleDefaultChange(deps, context.actor, modelId, thinking);
          }
          return deps.prisma.$transaction(
            async (tx) => {
              const { preferences, candidates } = await loadModelState(tx);
              if (candidates.length === 0) {
                throw new ORPCError("NOT_FOUND", {
                  message: `No model credential is connected for ${input.provider}.`,
                });
              }
              if (thinking.secret) {
                const current = await tx.secret.findFirst({
                  where: { id: thinking.secret.id, userId: context.actor.userId, spaceId: null },
                  select: { ciphertext: true },
                });
                if (current?.ciphertext !== thinking.secret.ciphertext) {
                  throw new ORPCError("CONFLICT", { message: "Model credentials changed; retry." });
                }
              }
              const savedModelId = new Map(
                preferences.map((preference) => [preference.credential.id, preference.modelId]),
              );
              const readyIds: string[] = [];
              let authFailure: string | undefined;
              let sawReadable = false;
              for (const candidate of candidates) {
                const prepared = preparedAuth.get(candidate.secretId);
                const current = await tx.secret.findFirst({
                  where: { id: candidate.secretId, userId: context.actor.userId, spaceId: null },
                  select: { id: true, ciphertext: true },
                });
                if (!prepared || (current?.ciphertext ?? null) !== prepared.ref) {
                  throw new ORPCError("CONFLICT", { message: "Model credentials changed; retry." });
                }
                const auth = prepared.auth;
                if (auth.status === "unreadable") continue;
                sawReadable = true;
                if (auth.status === "rejected") {
                  authFailure ??= auth.message;
                  continue;
                }
                // The enabled-list check and execution must use the same connection.
                if (compatible && thinking.secret && candidate.secretId !== thinking.secret.id)
                  continue;
                readyIds.push(candidate.id);
              }
              const chosenId = selectDefaultCredentialId({
                provider: input.provider,
                modelId: input.modelId,
                orderedIds: candidates.map((candidate) => candidate.id),
                readyIds,
                savedModelId: (credentialId) => savedModelId.get(credentialId),
              });
              const fallbackId = !sawReadable ? candidates[0]?.id : undefined;
              const credentialId = chosenId ?? fallbackId;
              if (!credentialId) {
                throw new ORPCError("BAD_REQUEST", {
                  message: authFailure ?? UNAVAILABLE_MODEL_FOR_AUTH_MESSAGE,
                });
              }
              const saved = input.thinkingLevel === undefined ? await savedChoices(tx) : [];
              let thinkingLevel: string | null =
                input.thinkingLevel === undefined
                  ? ((saved.find((choice) => choice.credentialId === credentialId) ?? saved[0])
                      ?.thinkingLevel ?? null)
                  : input.thinkingLevel;
              if (thinkingLevel) {
                if (!needsThinking) {
                  throw new ORPCError("CONFLICT", { message: "Model preferences changed; retry." });
                }
                thinkingLevel = clampCatalogThinkingLevel(thinkingLevel, thinking.allowed);
              }
              await writeModelRole(tx, await modelRoleTarget(tx, context.actor), "main", {
                primary: {
                  provider: input.provider,
                  modelId,
                  thinkingLevel: thinkingLevel as ThinkingLevel | null,
                  credentialId,
                },
              });
              // Older apps edit one model per connection here, so it becomes the connection's own.
              await saveModelPreference(tx, context.actor, credentialId, modelId, thinkingLevel);
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
          );
        }).catch((error: unknown) => {
          throw secretStoreOutage(error);
        });
        return { ok: true as const };
      }),
      saveModelSettings: authed.models.saveModelSettings.handler(async ({ context, input }) => {
        await saveConnectionModelSettings(deps, context.actor, input).catch((error: unknown) => {
          throw secretStoreOutage(error);
        });
        return { ok: true as const };
      }),
      rename: authed.models.rename.handler(async ({ context, input }) => {
        const renamed = await deps.prisma.userModelCredential.updateMany({
          where: { id: input.credentialId, userId: context.actor.userId },
          data: { label: input.label },
        });
        if (renamed.count === 0)
          throw new ORPCError("NOT_FOUND", { message: "Connection not found" });
        return { ok: true as const };
      }),
      disconnectPreview: authed.models.disconnectPreview.handler(async ({ context, input }) =>
        modelDisconnectPreview(deps, context.actor, input),
      ),
      disconnect: authed.models.disconnect.handler(async ({ context, input }) => {
        // Retire pending sign-ins in every space first — the credentials are
        // account-wide, so a finishing OAuth session anywhere could otherwise
        // re-persist a credential the delete below just removed. Removing one
        // connection leaves sign-ins that add another account running.
        await deps.oauthLogins.cancelProvider({
          userId: context.actor.userId,
          provider: input.provider,
          credentialId: input.credentialId,
        });
        await withTransactionRetry(() =>
          deps.prisma.$transaction(
            async (tx) => {
              const provider = modelCredentialProviderFilter(input.provider);
              const connections = await tx.userModelCredential.findMany({
                where: { userId: context.actor.userId, provider },
              });
              // Older apps disconnect every connection of the provider.
              const existing = input.credentialId
                ? connections.filter((row) => row.id === input.credentialId)
                : connections;
              if (input.credentialId && existing.length === 0) return;
              const ids = existing.map((row) => row.id);
              const lastConnection = existing.length === connections.length;
              const roleRows = disconnectedModelChoices(
                context.actor.userId,
                provider,
                ids,
                lastConnection,
              );
              // Its models leave every purpose in the account's models and every Space's,
              // like the connection itself; the tenant scope would otherwise limit the
              // Space deletes to the active Space.
              await tx.userModelRoleChoice.deleteMany({ where: roleRows });
              await runAsSystemInTransaction(
                tx,
                "disconnect a model connection from every Space",
                async () => {
                  await tx.spaceModelRoleChoice.deleteMany({ where: roleRows });
                },
              );
              if (existing.length === 0) return;
              // Credentials are account-wide, so disconnecting removes them from every Space.
              await tx.userModelCredential.deleteMany({
                where: { userId: context.actor.userId, id: { in: ids } },
              });
              for (const row of existing) {
                await deleteUnreferencedCredentialSecret(tx, {
                  credentialKind: "model",
                  credentialId: row.id,
                  secretId: row.secretId,
                });
              }
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
          ),
        );
        (deps.providerCatalog ?? providerCatalogCache).invalidate(
          canonicalPiProviderId(input.provider),
        );
        return { ok: true as const };
      }),
      deployment: {
        get: authed.models.deployment.get.handler(({ context }) =>
          getDeploymentModelSettings(deps, context.actor),
        ),
        update: authed.models.deployment.update.handler(async ({ context, input }) => {
          const saved = await updateDeploymentModelSettings(
            deps,
            context.actor,
            input,
            context.signal,
          );
          void deps.events?.publishSpaceChange?.(deploymentModelChangesScope, "deploymentModel");
          return saved;
        }),
      },
    },
  };
}
