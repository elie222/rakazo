import type { PrismaPushTokenStore, WorkActivities } from "@rakazo/adapters";
import { removePiUserSessions } from "@rakazo/adapters";
import type { AuthEnv } from "@rakazo/auth";
import type { ThreadEvents } from "@rakazo/db";
import { fullMembershipOrganizationIds } from "@rakazo/db";
import { bestEffort, getLogger } from "@rakazo/logging";
import { deleteAccountContent } from "../account/account-deletion.js";
import type { BillingService } from "../billing/billing.js";
import type { SpaceDeletionDeps } from "../spaces/space-deletion.js";
import type { DeviceStore } from "./user-devices.js";
import { endUserDeviceSession } from "./user-devices.js";

/** Cleanup after a change that already happened: a failure is logged, never thrown. */
async function logged(label: string, cleanup: Promise<void> | undefined) {
  await cleanup?.catch((error) => getLogger().error(label, error));
}

type AccountDeletionDeps = {
  spaceDeletion: SpaceDeletionDeps;
  events: ThreadEvents;
  billing: BillingService | undefined;
  pushTokens: PrismaPushTokenStore;
  workActivities: WorkActivities | undefined;
};

/** The same teardown and seat reconciliation for self-service and operator deletion. */
export function accountDeletionHooks(
  deps: AccountDeletionDeps,
): Required<Pick<AuthEnv, "beforeDeleteUser" | "afterDeleteUser">> {
  const { spaceDeletion, billing, pushTokens, workActivities } = deps;
  const { prisma, dataDir } = spaceDeletion;
  // Keep the account's full memberships until it is gone so surviving organizations recount seats.
  const seatsAfterDeletion = new Map<string, string[]>();
  return {
    beforeDeleteUser: async (userId) => {
      // Calendar cleanup and billing run under the Space claims, before content teardown.
      await deleteAccountContent({ ...spaceDeletion, events: deps.events, billing }, userId);
      await removePiUserSessions(dataDir, userId);
      await logged("push token removal failed", pushTokens.remove(userId));
      // Before the rows go with the account, so its phones' cards end too.
      await logged("live status card removal failed", workActivities?.endUser(userId));
      if (billing)
        seatsAfterDeletion.set(userId, await fullMembershipOrganizationIds(prisma, userId));
    },
    // Its memberships went with it, including its seat in an organization it co-owned.
    afterDeleteUser: async (userId) => {
      const organizationIds = seatsAfterDeletion.get(userId) ?? [];
      seatsAfterDeletion.delete(userId);
      for (const organizationId of organizationIds)
        await bestEffort(
          "seat count after an account deletion",
          billing?.syncSeats(organizationId),
        );
    },
  };
}

/** What the auth library calls as accounts and sessions end. */
export function accountLifecycleHooks(
  deps: AccountDeletionDeps & { deviceSessions: DeviceStore },
): Pick<
  AuthEnv,
  "beforeDeleteUser" | "afterDeleteUser" | "afterDeleteSession" | "afterReplaceSession"
> {
  const { pushTokens, workActivities, deviceSessions } = deps;
  return {
    ...accountDeletionHooks(deps),
    // The session change already happened, so a registration cleanup failure must not fail sign-out.
    afterDeleteSession: async (session) => {
      await logged("push token removal failed", pushTokens.endSession(session.userId, session.id));
      await logged(
        "live status card removal failed",
        workActivities?.endSession(session.userId, session.id),
      );
      await logged("user device revocation failed", endUserDeviceSession(deviceSessions, session));
    },
    afterReplaceSession: async (previous, session) => {
      await logged(
        "push token session update failed",
        pushTokens.endSession(session.userId, previous.id, session.id),
      );
      await logged(
        "live status card session update failed",
        workActivities?.endSession(session.userId, previous.id, session.id),
      );
      await logged(
        "user device session update failed",
        endUserDeviceSession(deviceSessions, previous, session),
      );
    },
  };
}
