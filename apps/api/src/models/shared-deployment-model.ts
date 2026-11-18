import { randomUUID } from "node:crypto";
import {
  SHARED_DEPLOYMENT_MODEL_RECORD,
  sharedDeploymentModel,
  sharedModelProviders,
  testSharedModel,
} from "@rakazo/adapters";
import type { Actor, SharedModelInput } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import { Prisma, recordAuditEvent, runAsSystem, withTransactionRetry } from "@rakazo/db";
import { requireAdmin } from "../auth/admins.js";
import type { RouterDeps } from "../router.js";

async function requireDeploymentModelAdmin(
  deps: Pick<RouterDeps, "billing" | "env"> & { prisma: Pick<RouterDeps["prisma"], "user"> },
  actor: Actor,
) {
  await requireAdmin(deps, actor.userId);
  if (deps.billing)
    throw new ClientError("FORBIDDEN", "Shared model settings require a self-hosted deployment");
}

function settingsRow(deps: RouterDeps) {
  return deps.prisma.deploymentSettings.findUnique({ where: { id: "default" } });
}

export async function sharedModelSettings(deps: RouterDeps, actor: Actor) {
  await requireDeploymentModelAdmin(deps, actor);
  const model = sharedDeploymentModel(await settingsRow(deps), true);
  return {
    connection: model && { provider: model.provider, modelId: model.modelId, method: model.method },
    providers: sharedModelProviders(),
  };
}

export async function configureSharedModel(
  deps: RouterDeps,
  actor: Actor,
  input: SharedModelInput | null,
  signal?: AbortSignal,
) {
  await requireDeploymentModelAdmin(deps, actor);
  const previous = await settingsRow(deps);
  const expected = previous?.sharedModelRevision ?? null;
  if (input) await testSharedModel(input, signal);
  signal?.throwIfAborted();
  const ciphertext = input
    ? (
        await deps.secrets.put(
          input.method === "api_key" ? input.apiKey : input.binding,
          {
            operationId: "deployment.model",
            traceId: "deployment.model",
            ...actor,
            signal: signal ?? new AbortController().signal,
          },
          // The singleton's binding stays in the deployment's encrypted config.
          { recordId: SHARED_DEPLOYMENT_MODEL_RECORD, ephemeral: true },
        )
      ).ciphertext
    : null;
  const update = {
    sharedModelProvider: input?.provider ?? null,
    sharedModelId: input?.modelId ?? null,
    sharedModelMethod: input?.method ?? null,
    sharedModelRevision: randomUUID(),
    sharedModelCipher: ciphertext,
  };
  await withTransactionRetry(() =>
    runAsSystem("a deployment admin configures the shared model", () =>
      deps.prisma.$transaction(
        async (tx) => {
          signal?.throwIfAborted();
          await requireDeploymentModelAdmin({ ...deps, prisma: tx }, actor);
          const row = await tx.deploymentSettings.findUnique({
            where: { id: "default" },
            select: { sharedModelRevision: true },
          });
          if ((row?.sharedModelRevision ?? null) !== expected)
            throw new ClientError(
              "CONFLICT",
              "The deployment model changed. Refresh settings and try again.",
            );
          await tx.deploymentSettings.upsert({
            where: { id: "default" },
            create: { id: "default", ...update },
            update,
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    ),
  );
  await recordAuditEvent({
    action: input ? "deployment.model.connected" : "deployment.model.disconnected",
    actor: { type: "user", id: actor.userId },
    spaceId: actor.spaceId,
    target: { type: "model_connection", id: SHARED_DEPLOYMENT_MODEL_RECORD },
  });
  return { ok: true as const };
}
