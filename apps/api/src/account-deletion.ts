import type { AdapterContext } from "@rakazo/adapter-kit";
import {
  destroyBot,
  removeAgentHome,
  removeDeletedBotsFromLegacyTeamHome,
  toComputerRef,
} from "@rakazo/adapters";
import {
  claimSpacesLeavingWithAccount,
  deleteSpaceLeavingWithAccount,
  recordComputerRunEnd,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { SpaceDeletionDeps } from "./space-deletion.js";

/**
 * In shared spaces, the account's bot folders also live on the space's Team Computer from before
 * each person got their own. Each sandbox is destroyed at its provider before its row goes, so a
 * failure keeps the handle and deleting again resumes from what is left.
 */
export async function deleteAccountContent(deps: SpaceDeletionDeps, userId: string): Promise<void> {
  const context = (spaceId: string, botId?: string): AdapterContext => ({
    operationId: `account-delete:${userId}`,
    traceId: `account-delete:${userId}`,
    spaceId,
    userId,
    ...(botId ? { botId } : {}),
    signal: new AbortController().signal,
  });
  const leaving = await claimSpacesLeavingWithAccount(deps.prisma, userId);
  const bots = await deps.prisma.bot.findMany({
    where: { OR: [{ userId }, { spaceId: { in: leaving } }] },
    select: {
      id: true,
      userId: true,
      spaceId: true,
      name: true,
      archivedAt: true,
      computerId: true,
      webhookSecretId: true,
    },
  });
  await settleAll(
    bots.map((bot) =>
      destroyBot(deps, bot, context(bot.spaceId, bot.id), {
        deleteMemories: true,
        strictTeardown: true,
      }),
    ),
  );

  // Bot deletion cleans these best-effort; here a failure fails the account deletion, and the
  // retry finds the ids again in bot_deletions.
  const deletions = await deps.prisma.botDeletion.findMany({
    where: { deletedByUserId: userId, spaceId: { notIn: leaving } },
    select: { id: true, spaceId: true },
  });
  const deletedBySpace = new Map<string, string[]>();
  for (const { id, spaceId } of deletions)
    deletedBySpace.set(spaceId, [...(deletedBySpace.get(spaceId) ?? []), id]);
  await settleAll(
    [...deletedBySpace].map(([spaceId, botIds]) =>
      removeDeletedBotsFromLegacyTeamHome(deps, spaceId, botIds),
    ),
  );

  const computers = await deps.prisma.computer.findMany({
    where: { OR: [{ userId }, { spaceId: { in: leaving } }] },
    select: {
      id: true,
      spaceId: true,
      homeKey: true,
      kind: true,
      providerRef: true,
      bots: { select: { id: true } },
    },
  });
  await settleAll(
    computers.map(async (computer) => {
      // Only someone else's bot can still be on it, and its files are theirs.
      if (computer.bots.length) {
        getLogger().warn("account.delete.computer_in_use", { "computer.id": computer.id });
        return;
      }
      if (computer.providerRef) {
        await deps.sandbox.destroy(toComputerRef(computer), context(computer.spaceId));
        await recordComputerRunEnd(deps.prisma, computer, "deleted");
      }
      await removeAgentHome(deps.home, computer.homeKey, deps.dataDir);
      // The row holds the stored home's key, so the stored copy is unreadable from here on.
      await deps.prisma.computer.deleteMany({
        where: { id: computer.id, providerRef: computer.providerRef, bots: { none: {} } },
      });
    }),
  );

  for (const spaceId of leaving) {
    const deleted = await deleteSpaceLeavingWithAccount(deps.prisma, { spaceId, userId });
    if (!deleted) continue;
    const cleanup = await Promise.allSettled(
      deleted.artifactKeys.map((storageKey) => deps.artifacts.remove(storageKey, context(spaceId))),
    );
    for (const result of cleanup) {
      if (result.status === "rejected") getLogger().error("space file cleanup", result.reason);
    }
  }
}

/** Runs every teardown, then fails with the first error so a retry finishes the rest. */
async function settleAll(work: Promise<unknown>[]) {
  const failed = (await Promise.allSettled(work)).find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failed) throw failed.reason;
}
