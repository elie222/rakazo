import type { ModelRole, ModelRoleChoice, ModelRoleSettings } from "@rakazo/contracts";
import {
  backupChoiceKey,
  canonicalPiProviderId,
  modelRoleChoiceKey,
  ThinkingLevelSchema,
} from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { withTransactionRetry } from "./transaction-retry.js";

type Scope = { userId: string; spaceId: string };
type RoleClient = Pick<PrismaClient, "spaceModelRoleChoice">;

/** The member's own ordered models for a purpose; empty when the deployment's defaults apply. */
export async function getModelRole(
  prisma: RoleClient,
  scope: Scope,
  role: ModelRole,
): Promise<ModelRoleSettings> {
  const rows = await prisma.spaceModelRoleChoice.findMany({
    where: { userId: scope.userId, spaceId: scope.spaceId, role },
    orderBy: { position: "asc" },
    select: {
      position: true,
      provider: true,
      modelId: true,
      thinkingLevel: true,
      credentialId: true,
    },
  });
  const choice = (row: (typeof rows)[number]): ModelRoleChoice => {
    const thinkingLevel = ThinkingLevelSchema.safeParse(row.thinkingLevel);
    return {
      provider: row.provider,
      modelId: row.modelId,
      ...(thinkingLevel.success ? { thinkingLevel: thinkingLevel.data } : {}),
      ...(row.credentialId ? { credentialId: row.credentialId } : {}),
    };
  };
  const primary = rows.find((row) => row.position === 0);
  return {
    primary: primary ? choice(primary) : null,
    backups: rows.filter((row) => row.position > 0).map(choice),
  };
}

export async function updateModelRole(
  prisma: PrismaClient,
  scope: Scope,
  role: ModelRole,
  patch: Partial<ModelRoleSettings>,
): Promise<ModelRoleSettings> {
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        // Lock a row that exists even when the list is empty. At ReadCommitted, the
        // rewrite after this lock observes the previous writer's committed list.
        const members = await tx.$queryRaw<Array<{ locked: number }>>`
          SELECT 1 AS locked FROM "space_members" WHERE "spaceId" = ${scope.spaceId} AND "userId" = ${scope.userId} FOR UPDATE
        `;
        if (members.length !== 1) throw new Error("Space membership not found");
        return writeModelRole(tx, scope, role, patch);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    ),
  );
}

/**
 * Rewrites a purpose's ordered list inside the caller's transaction. A choice without a
 * thinking level keeps the one its model already had, so reordering never resets effort.
 */
export async function writeModelRole(
  tx: RoleClient,
  scope: Scope,
  role: ModelRole,
  patch: Partial<ModelRoleSettings>,
): Promise<ModelRoleSettings> {
  const scoped = { userId: scope.userId, spaceId: scope.spaceId };
  const current = await getModelRole(tx, scope, role);
  const saved = [...(current.primary ? [current.primary] : []), ...current.backups];
  // The same row first, then the same model on another connection.
  const savedThinking = (choice: ModelRoleChoice) =>
    (
      saved.find((item) => modelRoleChoiceKey(item) === modelRoleChoiceKey(choice)) ??
      saved.find((item) => backupChoiceKey(item) === backupChoiceKey(choice))
    )?.thinkingLevel ?? null;
  // Apps that predate connections send rows without one; a row keeps the connection its
  // model already ran on when only one connection did.
  const savedConnection = (choice: ModelRoleChoice) => {
    const owners = saved.filter((item) => backupChoiceKey(item) === backupChoiceKey(choice));
    return owners.length === 1 ? owners[0]!.credentialId : undefined;
  };
  const withThinking = (choice: ModelRoleChoice): ModelRoleChoice => {
    const credentialId =
      choice.credentialId !== undefined ? choice.credentialId : savedConnection(choice);
    return {
      ...choice,
      provider: canonicalPiProviderId(choice.provider),
      ...(credentialId ? { credentialId } : {}),
      thinkingLevel:
        choice.thinkingLevel !== undefined ? choice.thinkingLevel : savedThinking(choice),
    };
  };
  const primary =
    patch.primary === undefined ? current.primary : patch.primary && withThinking(patch.primary);
  // The primary already runs first, so a matching fallback would never be tried.
  const backups = (patch.backups ?? current.backups)
    .map(withThinking)
    .filter(
      (backup, index, list) =>
        (!primary || modelRoleChoiceKey(backup) !== modelRoleChoiceKey(primary)) &&
        list.findIndex((item) => modelRoleChoiceKey(item) === modelRoleChoiceKey(backup)) === index,
    );
  await tx.spaceModelRoleChoice.deleteMany({ where: { ...scoped, role } });
  await tx.spaceModelRoleChoice.createMany({
    data: [
      ...(primary ? [{ ...primary, position: 0 }] : []),
      ...backups.map((backup, index) => ({ ...backup, position: index + 1 })),
    ].map((row) => ({
      ...scoped,
      role,
      position: row.position,
      provider: row.provider,
      modelId: row.modelId,
      thinkingLevel: row.thinkingLevel ?? null,
      credentialId: row.credentialId ?? null,
    })),
  });
  return getModelRole(tx, scope, role);
}
