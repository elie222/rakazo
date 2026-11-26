import { validateModelAuthAvailability } from "@rakazo/adapters";
import { ClientError } from "@rakazo/core";
import {
  managedOrganizationId,
  OrganizationAdminRequiredError,
  Prisma,
  runAsSystem,
  withTransactionRetry,
} from "@rakazo/db";
import { createModelConnector } from "../models/model-credentials.js";
import type { RouterContext } from "./context.js";

const connectionSummary = { id: true, provider: true, modelId: true, label: true } as const;

class OrganizationModelConnectionNotFoundError extends ClientError {
  constructor() {
    super("NOT_FOUND", "Organization model connection not found");
  }
}

export function organizationModelConnectionRoutes({ deps, authed, codexCatalog }: RouterContext) {
  const { verifyModelConnection } = createModelConnector(deps, codexCatalog);
  const procedures = authed.models.organizationConnections;

  return {
    list: procedures.list.handler(({ context: { actor } }) =>
      runAsSystem("list model connections for an organization admin", () =>
        deps.prisma.$transaction(async (tx) => {
          const organizationId = await managedOrganizationId(tx, actor);
          if (!organizationId) throw new OrganizationAdminRequiredError();
          return tx.organizationModelConnection.findMany({
            where: { organizationId },
            select: connectionSummary,
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          });
        }),
      ),
    ),
    create: procedures.create.handler(async ({ context: { actor }, input, signal }) => {
      const organizationId = await runAsSystem(
        "authorize organization model connection setup",
        () => managedOrganizationId(deps.prisma, actor),
      );
      if (!organizationId) throw new OrganizationAdminRequiredError();

      const { plaintext } = await verifyModelConnection(
        actor,
        { ...input, credentialId: null },
        signal,
      );
      const authError = validateModelAuthAvailability(input.provider, input.modelId, plaintext);
      if (authError) throw new ClientError("BAD_REQUEST", authError);

      // Seal inline so an organization deletion can remove the key with its row.
      const stored = await deps.secrets.put(
        plaintext,
        {
          operationId: "organization-model-connection",
          traceId: "organization-model-connection",
          spaceId: actor.spaceId,
          userId: actor.userId,
          signal: signal ?? new AbortController().signal,
        },
        { ephemeral: true },
      );

      return runAsSystem("save a model connection for an organization admin", () =>
        withTransactionRetry(() =>
          deps.prisma.$transaction(
            async (tx) => {
              if ((await managedOrganizationId(tx, actor)) !== organizationId)
                throw new OrganizationAdminRequiredError();
              signal?.throwIfAborted();
              return tx.organizationModelConnection.create({
                data: {
                  organizationId,
                  provider: input.provider,
                  modelId: input.modelId,
                  label: input.label,
                  supportsImages: input.supportsImages ?? false,
                  secretId: stored.id,
                  ciphertext: stored.ciphertext,
                },
                select: connectionSummary,
              });
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
          ),
        ),
      );
    }),
    remove: procedures.remove.handler(({ context: { actor }, input }) =>
      runAsSystem("remove a model connection for an organization admin", () =>
        withTransactionRetry(() =>
          deps.prisma.$transaction(
            async (tx) => {
              const organizationId = await managedOrganizationId(tx, actor);
              if (!organizationId) throw new OrganizationAdminRequiredError();
              const removed = await tx.organizationModelConnection.deleteMany({
                where: { organizationId, id: input.id },
              });
              if (!removed.count) throw new OrganizationModelConnectionNotFoundError();
              return { ok: true as const };
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
          ),
        ),
      ),
    ),
  };
}
