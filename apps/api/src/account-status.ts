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
    if (!change.active) await endDeactivatedAccess(deps, change.userId);
    if (!change.changed) return;
    await recordSecurityEvent({
      type: change.active ? "auth.account.reactivated" : "auth.account.deactivated",
      userId: change.userId,
      metadata: { by: "directory" },
    });
  });
}

/**
 * Ends what a deactivated account had going: sign-ins, paired computers, notification
 * registrations and runs. Its bots, chats, memory, files and connections stay. Sign-in and
 * new runs are refused separately for as long as the account stays deactivated.
 */
export async function endDeactivatedAccess(deps: AccountStatusDeps, userId: string) {
  const { prisma } = deps;
  await prisma.session.deleteMany({ where: { userId } });
  await revokeUserDevices(deps.devices, userId);
  await deps.pushTokens.remove(userId);
  await prisma.callPushDevice.deleteMany({ where: { userId } });
  for (const { threadId, seq } of await cancelDeactivatedAccountRuns(prisma, userId))
    await deps.events.notify(threadId, seq).catch((error) => {
      getLogger().error("deactivated account run cancellation notification", error);
    });
}
