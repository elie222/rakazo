import { validateModelAuthAvailability } from "@rakazo/adapters";
import { ClientError } from "@rakazo/core";
import {
  accountPreferencesChangesScope,
  lockOrganizationMembers,
  managedOrganizationId,
  OrganizationAdminRequiredError,
  organizationModelConnectionIn,
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

  const membershipKey = (actor: { spaceId: string; userId: string }) => ({
    spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId },
  });

  return {
    available: procedures.available.handler(({ context: { actor } }) =>
      runAsSystem("read organization model choices for a Space member", async () => {
        const membership = await deps.prisma.spaceMember.findUnique({
          where: membershipKey(actor),
          select: { organizationModelConnectionId: true },
        });
        const [connections, managed] = membership
          ? await Promise.all([
              deps.prisma.organizationModelConnection.findMany({
                where: organizationModelConnectionIn(actor),
                select: connectionSummary,
                orderBy: [{ createdAt: "asc" }, { id: "asc" }],
              }),
              managedOrganizationId(deps.prisma, actor),
            ])
          : ([[], null] as const);
        return {
          connections: [...connections],
          selectedId: membership?.organizationModelConnectionId ?? null,
          canManage: managed !== null,
        };
      }),
    ),
    select: procedures.select.handler(async ({ context: { actor }, input }) => {
      await runAsSystem("select an organization model for a Space member", () =>
        withTransactionRetry(() =>
          deps.prisma.$transaction(
            async (tx) => {
              const connection = input.id
                ? await tx.organizationModelConnection.findFirst({
                    where: { id: input.id, ...organizationModelConnectionIn(actor) },
                    select: connectionSummary,
                  })
                : null;
              if (input.id && !connection) throw new OrganizationModelConnectionNotFoundError();
              const result = await tx.spaceMember.updateMany({
                where: { spaceId: actor.spaceId, userId: actor.userId },
                data: {
                  organizationModelConnectionId: connection?.id ?? null,
                  organizationModelProvider: connection?.provider ?? null,
                  organizationModelId: connection?.modelId ?? null,
                },
              });
              if (!result.count) throw new OrganizationModelConnectionNotFoundError();
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
          ),
        ),
      );
      await deps.events?.publishSpaceChange?.(
        accountPreferencesChangesScope(actor.userId),
        "preferences",
      );
      return { ok: true as const };
    }),
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

      const connection = await runAsSystem(
        "save a model connection for an organization admin",
        () =>
          deps.prisma.$transaction(
            async (tx) => {
              await lockOrganizationMembers(tx, organizationId);
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
            { isolationLevel: "ReadCommitted" },
          ),
      );
      await deps.events?.publishOrganizationChange?.(organizationId);
      return connection;
    }),
    remove: procedures.remove.handler(async ({ context: { actor }, input }) => {
      const organizationId = await runAsSystem(
        "remove a model connection for an organization admin",
        () =>
          deps.prisma.$transaction(
            async (tx) => {
              const space = await tx.space.findUnique({
                where: { id: actor.spaceId },
                select: { organizationId: true },
              });
              if (!space) throw new OrganizationAdminRequiredError();
              await lockOrganizationMembers(tx, space.organizationId);
              const organizationId = await managedOrganizationId(tx, actor);
              if (organizationId !== space.organizationId)
                throw new OrganizationAdminRequiredError();
              const removed = await tx.organizationModelConnection.deleteMany({
                where: { organizationId, id: input.id },
              });
              if (!removed.count) throw new OrganizationModelConnectionNotFoundError();
              return organizationId;
            },
            { isolationLevel: "ReadCommitted" },
          ),
      );
      await deps.events?.publishOrganizationChange?.(organizationId);
      return { ok: true as const };
    }),
  };
}
