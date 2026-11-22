import type { SecretCleanup } from "@rakazo/adapters";
import {
  adminDeploymentModel,
  assertModelProviderAllowed,
  cleanUpUnsavedSecret,
  DEPLOYMENT_MODEL_RECORD,
  deploymentModelProviders,
  finishSecretCleanup,
  modelCreditOfferings,
  modelProviderAllowed,
  modelProviderAllowlist,
  parseModelSecret,
  recordSecretCleanup,
  savedSecretIn,
  verifyCatalogProviderApiKey,
} from "@rakazo/adapters";
import type { Actor, DeploymentModelSettings, DeploymentModelUpdate } from "@rakazo/contracts";
import { canonicalPiProviderId } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import { Prisma, runAsSystem, withTransactionRetry } from "@rakazo/db";
import { requireAdmin } from "../auth/admins.js";
import type { RouterDeps } from "../router.js";
import { modelConnectionErrorMessage } from "./model-credentials.js";

export type DeploymentModelSettingsDeps = Pick<
  RouterDeps,
  "prisma" | "secrets" | "jobs" | "billing" | "modelConnectionFetch" | "modelConnectionCheck"
> & { env: Pick<RouterDeps["env"], "adminEmails"> };

const SAVED = {
  defaultModelProvider: true,
  defaultModelId: true,
  deploymentModelCredentialCipher: true,
} as const;

/** Credits always run on the operator's own connection, so there is nothing for an admin to set. */
function available(deps: DeploymentModelSettingsDeps) {
  return !deps.billing?.modelCreditsEnabled && !modelCreditOfferings();
}

function view(
  deps: DeploymentModelSettingsDeps,
  saved: {
    defaultModelProvider: string | null;
    defaultModelId: string | null;
    deploymentModelCredentialCipher: string | null;
  } | null,
): DeploymentModelSettings {
  // Only a default saved with its key is an admin's; one without belongs to the environment.
  const own = saved?.deploymentModelCredentialCipher ? saved : null;
  // One that credits or the allowlist set aside shows as the environment's, which is what runs,
  // while its key stays saved until an admin removes it.
  const active = own && available(deps) ? adminDeploymentModel(own) : null;
  const allowlist = modelProviderAllowlist();
  return {
    provider: active ? own!.defaultModelProvider : null,
    modelId: active ? own!.defaultModelId : null,
    keySaved: Boolean(own),
    providers: available(deps)
      ? deploymentModelProviders().filter((provider) =>
          modelProviderAllowed(allowlist, provider.id),
        )
      : [],
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
  if (input.provider === null) {
    // Serializable like a save, so a save that lands meanwhile is never cleared unrecorded.
    const dropped = await withTransactionRetry(() =>
      runAsSystem("an admin goes back to the environment's model", () =>
        deps.prisma.$transaction(
          async (tx) => {
            const current = await tx.deploymentSettings.findUnique({
              where: { id: "default" },
              select: SAVED,
            });
            // A default saved without a key is the environment's own and stays.
            if (!current?.deploymentModelCredentialCipher) return undefined;
            await tx.deploymentSettings.update({
              where: { id: "default" },
              data: {
                defaultModelProvider: null,
                defaultModelId: null,
                deploymentModelCredentialCipher: null,
              },
            });
            const cleanup = deploymentSecret(current.deploymentModelCredentialCipher);
            await recordSecretCleanup(deps, tx, cleanup);
            return cleanup;
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        ),
      ),
    );
    if (dropped) await finishSecretCleanup(deps, dropped);
    return view(deps, null);
  }
  if (!available(deps))
    throw new ClientError("BAD_REQUEST", "This server's model is set by its operator");
  assertModelProviderAllowed(input.provider);
  const provider = deploymentModelProviders().find(
    (entry) => canonicalPiProviderId(entry.id) === canonicalPiProviderId(input.provider),
  );
  if (!provider) throw new ClientError("BAD_REQUEST", "Choose a provider that connects with a key");
  if (!provider.models.some((model) => model.id === input.modelId))
    throw new ClientError("BAD_REQUEST", "Unknown model for this provider");
  const previous = await readSaved(deps);
  const keepsKey =
    !input.apiKey &&
    Boolean(previous?.deploymentModelCredentialCipher) &&
    previous?.defaultModelProvider === provider.id;
  if (!input.apiKey && !keepsKey) throw new ClientError("BAD_REQUEST", "Enter an API key");
  let ciphertext = previous?.deploymentModelCredentialCipher ?? null;
  // A kept key is checked against a newly chosen model too, which it may not reach.
  if (keepsKey && previous?.defaultModelId !== input.modelId) {
    const saved = parseModelSecret(await deps.secrets.load(ciphertext!, DEPLOYMENT_MODEL_RECORD));
    if (saved.kind === "api_key")
      await verifyKey(deps, provider.id, input.modelId, saved.key, signal);
  }
  if (input.apiKey) {
    await verifyKey(deps, provider.id, input.modelId, input.apiKey, signal);
    // Owned by the deployment row, not a user or space, so no account deletion removes it.
    ciphertext = (
      await deps.secrets.put(
        JSON.stringify({ kind: "api_key", key: input.apiKey }),
        {
          operationId: "deployment-model",
          traceId: "deployment-model",
          spaceId: actor.spaceId,
          userId: actor.userId,
          signal: signal ?? new AbortController().signal,
        },
        { recordId: DEPLOYMENT_MODEL_RECORD },
      )
    ).ciphertext;
  }
  const stored = ciphertext!;
  let replaced: SecretCleanup | undefined;
  try {
    // Read what this save replaces in the same transaction, so concurrent saves each remove theirs.
    replaced = await withTransactionRetry(() =>
      runAsSystem("an admin sets the deployment's default model", () =>
        deps.prisma.$transaction(
          async (tx) => {
            const current = await tx.deploymentSettings.findUnique({
              where: { id: "default" },
              select: SAVED,
            });
            // The kept key must still be the one this save read, or it was replaced meanwhile.
            if (!input.apiKey && current?.deploymentModelCredentialCipher !== stored)
              throw new ClientError("CONFLICT", "The model settings changed. Try again.");
            const data = {
              defaultModelProvider: provider.id,
              defaultModelId: input.modelId,
              deploymentModelCredentialCipher: stored,
            };
            await tx.deploymentSettings.upsert({
              where: { id: "default" },
              create: { id: "default", ...data },
              update: data,
            });
            await savedSecretIn(deps, tx, stored);
            const before = current?.deploymentModelCredentialCipher;
            if (!before || before === stored) return undefined;
            const cleanup = deploymentSecret(before);
            await recordSecretCleanup(deps, tx, cleanup);
            return cleanup;
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        ),
      ),
    );
  } catch (error) {
    if (input.apiKey) await cleanUpUnsavedSecret(deps, deploymentSecret(stored));
    throw error;
  }
  if (replaced) await finishSecretCleanup(deps, replaced);
  return view(deps, {
    defaultModelProvider: provider.id,
    defaultModelId: input.modelId,
    deploymentModelCredentialCipher: stored,
  });
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
