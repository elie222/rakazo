import type { ModelRole, ModelRoleChoice, ModelRoleSettings } from "@rakazo/contracts";
import { backupChoiceKey, canonicalPiProviderId, ThinkingLevelSchema } from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { writeSpaceBackupModels } from "./model-backups.js";
import { selectSpaceModelPreference } from "./model-credentials.js";
import { withTransactionRetry } from "./transaction-retry.js";

type Scope = { userId: string; spaceId: string };
type RoleClient = Pick<PrismaClient, "spaceModelRoleChoice">;
type RoleWriteClient = Pick<
  PrismaClient,
  "spaceModelRoleChoice" | "spaceModelPreference" | "spaceBackupModel"
>;

export type ModelRoleWriteOptions = {
  /**
   * The connection serving a newly written main model, or null for a deployment-managed one.
   * The previous release reads the main model from that connection's default preference.
   */
  primaryCredentialId?: string | null;
};

/** The member's own ordered models for a purpose; empty when the deployment's defaults apply. */
export async function getModelRole(
  prisma: RoleClient,
  scope: Scope,
  role: ModelRole,
): Promise<ModelRoleSettings> {
  const rows = await prisma.spaceModelRoleChoice.findMany({
    where: { userId: scope.userId, spaceId: scope.spaceId, role },
    orderBy: { position: "asc" },
    select: { position: true, provider: true, modelId: true, thinkingLevel: true },
  });
  const choice = (row: (typeof rows)[number]): ModelRoleChoice => {
    const thinkingLevel = ThinkingLevelSchema.safeParse(row.thinkingLevel);
    return {
      provider: row.provider,
      modelId: row.modelId,
      ...(thinkingLevel.success ? { thinkingLevel: thinkingLevel.data } : {}),
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
  options: ModelRoleWriteOptions = {},
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
        return writeModelRole(tx, scope, role, patch, options);
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
  tx: RoleWriteClient,
  scope: Scope,
  role: ModelRole,
  patch: Partial<ModelRoleSettings>,
  options: ModelRoleWriteOptions = {},
): Promise<ModelRoleSettings> {
  const scoped = { userId: scope.userId, spaceId: scope.spaceId };
  const current = await getModelRole(tx, scope, role);
  const saved = [...(current.primary ? [current.primary] : []), ...current.backups];
  const withThinking = (choice: ModelRoleChoice): ModelRoleChoice => ({
    ...choice,
    provider: canonicalPiProviderId(choice.provider),
    thinkingLevel:
      choice.thinkingLevel !== undefined
        ? choice.thinkingLevel
        : (saved.find((item) => backupChoiceKey(item) === backupChoiceKey(choice))?.thinkingLevel ??
          null),
  });
  const primary =
    patch.primary === undefined ? current.primary : patch.primary && withThinking(patch.primary);
  // The primary already runs first, so a matching fallback would never be tried.
  const backups = (patch.backups ?? current.backups)
    .filter((backup) => !primary || backupChoiceKey(backup) !== backupChoiceKey(primary))
    .map(withThinking);
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
    })),
  });
  if (role === "main") {
    await mirrorPreviousMainModel(
      tx,
      scope,
      { primary: patch.primary === undefined ? undefined : primary, backups },
      options.primaryCredentialId ?? null,
    );
  }
  return getModelRole(tx, scope, role);
}

/** Keeps the default preference and space_backup_models the previous release reads. */
async function mirrorPreviousMainModel(
  tx: RoleWriteClient,
  scope: Scope,
  main: { primary: ModelRoleChoice | null | undefined; backups: ModelRoleChoice[] },
  credentialId: string | null,
) {
  if (main.primary && credentialId) {
    await selectSpaceModelPreference(
      tx,
      scope,
      credentialId,
      main.primary.modelId,
      main.primary.thinkingLevel ?? null,
    );
  } else if (main.primary !== undefined) {
    await tx.spaceModelPreference.updateMany({
      where: { userId: scope.userId, spaceId: scope.spaceId, isDefault: true },
      data: { isDefault: false },
    });
  }
  await writeSpaceBackupModels(
    tx,
    scope,
    main.backups.map(({ provider, modelId }) => ({ provider, modelId })),
  );
}
