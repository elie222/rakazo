import type { SecretCleanup } from "@rakazo/adapters";
import {
  adminDeploymentModel,
  assertModelProviderAllowed,
  cleanUpUnsavedSecret,
  DEPLOYMENT_MODEL_RECORD,
  deploymentModelProviders,
  finishSecretCleanup,
  loadAdminDeploymentModelKey,
  modelCreditOfferings,
  recordSecretCleanup,
  savedSecretIn,
  verifyCatalogProviderApiKey,
} from "@rakazo/adapters";
import type { Actor, DeploymentModelSettings, DeploymentModelUpdate } from "@rakazo/contracts";
import { canonicalPiProviderId } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import { Prisma, recordSecurityEvent, runAsSystem, withTransactionRetry } from "@rakazo/db";
import { requireAdmin } from "../auth/admins.js";
import type { RouterDeps } from "../router.js";
import { modelConnectionErrorMessage } from "./model-credentials.js";

export type DeploymentModelSettingsDeps = Pick<
  RouterDeps,
  "prisma" | "secrets" | "jobs" | "billing" | "modelConnectionFetch" | "modelConnectionCheck"
> & { env: Pick<RouterDeps["env"], "adminEmails"> };

const SAVED = {
  deploymentModelProvider: true,
  deploymentModelId: true,
  deploymentModelCredentialCipher: true,
  modelCreditsEnabled: true,
} as const;

type SavedSettings = Prisma.DeploymentSettingsGetPayload<{ select: typeof SAVED }>;

function available(
  deps: DeploymentModelSettingsDeps,
  saved: Pick<SavedSettings, "modelCreditsEnabled"> | null,
) {
  return (
    !deps.billing?.modelCreditsEnabled && !saved?.modelCreditsEnabled && !modelCreditOfferings()
  );
}

function view(
  deps: DeploymentModelSettingsDeps,
  saved: SavedSettings | null,
): DeploymentModelSettings {
  const canSet = available(deps, saved);
  const active = canSet ? adminDeploymentModel(saved) : null;
  return {
    provider: active?.provider ?? null,
    modelId: active?.modelId ?? null,
    keySaved: Boolean(saved?.deploymentModelCredentialCipher),
    providers: canSet ? deploymentModelProviders() : [],
  };
}

function readSaved(deps: DeploymentModelSettingsDeps) {
  return runAsSystem("read the deployment's default model", () =>
    deps.prisma.deploymentSettings.findUnique({ where: { id: "default" }, select: SAVED }),
  );
}

export async function getDeploymentModelSettings(
  deps: DeploymentModelSettingsDeps,
  actor: Actor,
): Promise<DeploymentModelSettings> {
  await requireAdmin(deps, actor.userId);
  return view(deps, await readSaved(deps));
}

/**
 * Sets the model members without their own run on, with the key that pays for it, or goes back
 * to the environment's. Runs read it when they start, so no restart is needed.
 */
export async function updateDeploymentModelSettings(
  deps: DeploymentModelSettingsDeps,
  actor: Actor,
  input: DeploymentModelUpdate,
  signal?: AbortSignal,
): Promise<DeploymentModelSettings> {
  await requireAdmin(deps, actor.userId);
  const data =
    input.provider === null
      ? {
          deploymentModelProvider: null,
          deploymentModelId: null,
          deploymentModelCredentialCipher: null,
        }
      : await prepareModel(deps, actor, input, signal);
  const newSecret =
    input.provider !== null && input.apiKey
      ? deploymentSecret(data.deploymentModelCredentialCipher!)
      : undefined;
  const keptSecret =
    input.provider !== null && !input.apiKey ? data.deploymentModelCredentialCipher : null;

  const result = await withTransactionRetry(() =>
    runAsSystem("update the deployment model", () =>
      deps.prisma.$transaction(
        async (tx) => {
          const current = await tx.deploymentSettings.findUnique({
            where: { id: "default" },
            select: SAVED,
          });
          const before = current?.deploymentModelCredentialCipher;
          if (input.provider === null && !before) return { saved: current };
          if (input.provider !== null && !available(deps, current)) {
            throw new ClientError("BAD_REQUEST", "This server's model is set by its operator");
          }
          if (keptSecret && before !== keptSecret) {
            throw new ClientError("CONFLICT", "The model settings changed. Try again.");
          }
          if (
            keptSecret &&
            current?.deploymentModelProvider === data.deploymentModelProvider &&
            current?.deploymentModelId === data.deploymentModelId
          )
            return { saved: current };
          await tx.deploymentSettings.upsert({
            where: { id: "default" },
            create: { id: "default", ...data },
            update: data,
          });
          if (newSecret) await savedSecretIn(deps, tx, newSecret.ref);
          const cleanup =
            before && before !== data.deploymentModelCredentialCipher
              ? deploymentSecret(before)
              : undefined;
          if (cleanup) await recordSecretCleanup(deps, tx, cleanup);
          return {
            saved: { ...data, modelCreditsEnabled: current?.modelCreditsEnabled ?? false },
            cleanup,
            event: {
              type:
                input.provider === null
                  ? ("credential.deleted" as const)
                  : before
                    ? ("credential.changed" as const)
                    : ("credential.created" as const),
              userId: actor.userId,
              spaceId: actor.spaceId,
              metadata: {
                procedure: "models.deployment.update",
                kind: "deployment_model",
                provider: data.deploymentModelProvider ?? current?.deploymentModelProvider ?? null,
              },
            },
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    ),
  ).catch(async (error: unknown) => {
    if (newSecret) await cleanUpUnsavedSecret(deps, newSecret);
    throw error;
  });
  if (result.event) await recordSecurityEvent(result.event);
  if (result.cleanup) await finishSecretCleanup(deps, result.cleanup);
  return view(deps, result.saved);
}

async function prepareModel(
  deps: DeploymentModelSettingsDeps,
  actor: Actor,
  input: Exclude<DeploymentModelUpdate, { provider: null }>,
  signal?: AbortSignal,
) {
  const previous = await readSaved(deps);
  if (!available(deps, previous))
    throw new ClientError("BAD_REQUEST", "This server's model is set by its operator");
  assertModelProviderAllowed(input.provider);
  const provider = deploymentModelProviders().find(
    (entry) => canonicalPiProviderId(entry.id) === canonicalPiProviderId(input.provider),
  );
  if (!provider) throw new ClientError("BAD_REQUEST", "Choose a provider that connects with a key");
  if (!provider.models.some((model) => model.id === input.modelId))
    throw new ClientError("BAD_REQUEST", "Unknown model for this provider");

  let cipher: string;
  if (input.apiKey) {
    await verifyKey(deps, provider.id, input.modelId, input.apiKey, signal);
    const sealed = await deps.secrets.put(
      JSON.stringify({ kind: "api_key", key: input.apiKey }),
      {
        operationId: "deployment-model",
        traceId: "deployment-model",
        spaceId: actor.spaceId,
        userId: actor.userId,
        signal: signal ?? new AbortController().signal,
      },
      { recordId: DEPLOYMENT_MODEL_RECORD },
    );
    cipher = sealed.ciphertext;
  } else {
    if (
      previous?.deploymentModelProvider !== provider.id ||
      !previous.deploymentModelCredentialCipher
    )
      throw new ClientError("BAD_REQUEST", "Enter an API key");
    cipher = previous.deploymentModelCredentialCipher;
    if (previous.deploymentModelId !== input.modelId) {
      const key = await loadAdminDeploymentModelKey(deps.secrets, cipher);
      await verifyKey(deps, provider.id, input.modelId, key, signal);
    }
  }
  return {
    deploymentModelProvider: provider.id,
    deploymentModelId: input.modelId,
    deploymentModelCredentialCipher: cipher,
  };
}

/** The same checks a member's own key gets before it is saved. */
async function verifyKey(
  deps: DeploymentModelSettingsDeps,
  provider: string,
  modelId: string,
  apiKey: string,
  signal?: AbortSignal,
) {
  try {
    await verifyCatalogProviderApiKey({ provider, apiKey }, deps.modelConnectionFetch, signal);
    await deps.modelConnectionCheck?.(
      { provider, id: modelId, apiKey },
      { fetch: deps.modelConnectionFetch, signal },
    );
  } catch (error) {
    // A cancelled save is not a rejected key.
    if (signal?.aborted) throw error;
    // The checks refuse a key with plain errors, as for a member's own connection.
    throw new ClientError(
      "BAD_REQUEST",
      modelConnectionErrorMessage(error, "Invalid model connection", { apiKey }),
    );
  }
}

function deploymentSecret(ref: string): SecretCleanup {
  return { kind: "deployment_model", recordId: DEPLOYMENT_MODEL_RECORD, ref };
}
