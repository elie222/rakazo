import type { PushTokenStore } from "@rakazo/adapters";
import type { DirectoryAccountChange } from "@rakazo/auth";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { cancelDeactivatedAccountRuns, recordSecurityEvent, runAsSystem } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { DeviceStore } from "./user-devices.js";
import { revokeUserDevices } from "./user-devices.js";

export interface AccountStatusDeps {
  prisma: PrismaClient;
  pushTokens: Pick<PushTokenStore, "remove">;
  devices: DeviceStore;
  events: Pick<ThreadEvents, "notify">;
}

/** Who turned an account off or on: the identity provider over SCIM, or the operator's command. */
export type AccountStatusActor = "directory" | "operator";

/**
 * Finishes a directory change once its SCIM request committed. The account row says what
 * happened: a change in a request that rolled back finds it as before and does nothing.
 * Ending a deactivated account's access is repeatable; only a real change is recorded.
 */
export async function settleDirectoryChange(
  deps: AccountStatusDeps,
  change: DirectoryAccountChange,
): Promise<void> {
  await runAsSystem("settle a directory account change", async () => {
    const user = await deps.prisma.user.findUnique({
      where: { id: change.userId },
      select: { deactivatedAt: true },
    });
    if (!user || change.active === Boolean(user.deactivatedAt)) return;
    // Recorded first: a failed cleanup fails the request, and its retry is no change.
    if (change.changed) await recordAccountStatus(change.userId, change.active, "directory");
    if (!change.active) await endDeactivatedAccess(deps, change.userId);
  });
}

/**
 * Turns an account off or back on outside the directory. Returns whether that changed it;
 * deactivating an account that already is off still finishes ending its access.
 */
export async function setAccountActive(
  deps: AccountStatusDeps,
  userId: string,
  active: boolean,
  by: AccountStatusActor,
): Promise<boolean> {
  return runAsSystem("change an account's status", async () => {
    const { count } = await deps.prisma.user.updateMany({
      where: { id: userId, deactivatedAt: active ? { not: null } : null },
      data: { deactivatedAt: active ? null : new Date() },
    });
    if (count) await recordAccountStatus(userId, active, by);
    if (!active) await endDeactivatedAccess(deps, userId);
    return count > 0;
  });
}

function recordAccountStatus(userId: string, active: boolean, by: AccountStatusActor) {
  return recordSecurityEvent({
    type: active ? "auth.account.reactivated" : "auth.account.deactivated",
    userId,
    metadata: { by },
  });
}

/**
 * Ends what a deactivated account had going: sign-ins, paired computers, notification
 * registrations, views of its bots' screens, and runs. Its bots, chats, memory, files and
 * connections stay. Sign-in and new runs are refused separately for as long as the account
 * stays deactivated. Every step is tried even when an earlier one fails, and running it again
 * is safe; the operator's `account-status.js deactivate` does.
 */
export async function endDeactivatedAccess(deps: AccountStatusDeps, userId: string) {
  const { prisma } = deps;
  const steps = [
    () => prisma.session.deleteMany({ where: { userId } }),
    () => revokeUserDevices(deps.devices, userId),
    () => deps.pushTokens.remove(userId),
    () => prisma.callPushDevice.deleteMany({ where: { userId } }),
    // Screen links issued before now stop working; people still allowed get new ones.
    () =>
      prisma.bot.updateMany({ where: { userId }, data: { screenGeneration: { increment: 1 } } }),
    async () => {
      for (const { threadId, seq } of await cancelDeactivatedAccountRuns(prisma, userId))
        await deps.events.notify(threadId, seq).catch((error) => {
          getLogger().error("deactivated account run cancellation notification", error);
        });
    },
  ];
  const failures: unknown[] = [];
  for (const step of steps) await step().catch((error: unknown) => failures.push(error));
  if (failures.length)
    throw new AggregateError(failures, "Could not finish ending a deactivated account's access");
}
