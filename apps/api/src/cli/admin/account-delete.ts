import {
  configuredMessaging,
  createAgentHomeStore,
  createArtifactStore,
  createMeetingServices,
  createPushDelivery,
  createRunSandbox,
  GraphileJobPublisher,
  machineCleanupRecords,
  PostgresRealtimeFanout,
  RunJobPublisher,
  RunStarter,
  SpaceMemoryProviderResolver,
  UserDevices,
  userDeviceForwardSecret,
} from "@rakazo/adapters";
import {
  assertNoOwnedOrganizationWithMembers,
  clearAccountIdentity,
  createThreadEvents,
  fullMembershipOrganizationIds,
  ownedBillingAccounts,
  personalOrganizationIds,
  recordAuditEvent,
  recordSecurityEvent,
} from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import { accountDeletionHooks } from "../../auth/session-hooks.js";
import { revokeUserDevices } from "../../auth/user-devices.js";
import { createBillingService } from "../../billing/billing.js";
import { adminEmail, findAdminAccount } from "./account-target.js";
import type { AdminCommand, AdminContext } from "./admin-command.js";
import { AdminCommandError } from "./admin-command.js";
import { adminBillingProvider } from "./billing-provider.js";

export const accountDeleteCommand: AdminCommand = {
  path: ["account", "delete"],
  usage: "<email> [--confirm]",
  flags: ["confirm"],
  parse: ([address, ...extra], flags) => {
    const email = adminEmail(address);
    if (!email || extra.length) return null;
    return async (context) => {
      const user = await findAdminAccount(context.prisma, email);
      await assertNoOwnedOrganizationWithMembers(context.prisma, user.id);
      if (!flags.confirm)
        return {
          text: `Add --confirm to permanently delete the account for ${user.email} (${user.id}).`,
          json: { userId: user.id, deleted: false },
        };
      await deleteAccount(context, user.id);
      return { text: "Account deleted.", json: { userId: user.id, deleted: true } };
    };
  },
};

async function deleteAccount({ env, pool, prisma, secrets }: AdminContext, userId: string) {
  if (env.wakeupDriver === "memory")
    throw new AdminCommandError("Account deletion from the CLI requires the database job runner");
  const provider = adminBillingProvider(env);
  if (!provider) {
    const departing = new Set(await personalOrganizationIds(prisma, userId));
    const billing = await ownedBillingAccounts(prisma, userId);
    if (billing.some(({ organizationId }) => departing.has(organizationId)))
      throw new AdminCommandError(
        "Configure billing before deleting an account with billing records",
      );
  }

  const realtime = new PostgresRealtimeFanout({
    connectionString: env.realtimeDatabaseUrl,
    publisher: pool,
  });
  const starter = new RunStarter(realtime);
  const jobs = new RunJobPublisher(prisma, new GraphileJobPublisher(pool, prisma), starter);
  try {
    const sandbox = await createRunSandbox(env.sandboxProvider, {
      ...env.sandboxOptions,
      supervisorUrl: env.sandboxSupervisorUrl,
      supervisorToken: env.sandboxSupervisorToken,
      dataDir: env.dataDir,
      prisma,
      secrets,
      unreferencedMachines: machineCleanupRecords(jobs),
    });
    const events = createThreadEvents(prisma, realtime);
    const { installations: messagingInstallations } = configuredMessaging({
      prisma,
      secrets,
      jobs,
      env,
      deploymentModelConfigured: env.deploymentModelConfigured,
      openSignup: env.messagingOpenSignup,
      pollInboundMessages: false,
    });
    const { meetings, calendar: meetingCalendar } = await createMeetingServices({
      prisma,
      jobs,
      events,
      webOrigin: env.webOrigin,
    });
    const { pushTokens, workActivities } = await createPushDelivery({
      prisma,
      jobs,
      encryptionKey: env.encryptionKey,
      expoAccessToken: env.expoAccessToken,
      apnsVoip: env.apnsVoip,
    });
    const hooks = accountDeletionHooks({
      events,
      billing:
        provider && createBillingService({ prisma, provider, realtime, webOrigin: env.webOrigin }),
      pushTokens,
      workActivities,
      spaceDeletion: {
        prisma,
        sandbox,
        jobs,
        dataDir: env.dataDir,
        home: createAgentHomeStore(env.dataDir, prisma, process.env, env.workspaceSaveLimits),
        artifacts: createArtifactStore(env.dataDir, prisma),
        memoryProviders: new SpaceMemoryProviderResolver(prisma, secrets),
        messagingInstallations,
        meetings,
        meetingCalendar,
        secrets,
      },
    });
    const organizationIds = await fullMembershipOrganizationIds(prisma, userId);
    await recordSecurityEvent({
      type: "auth.account.delete_requested",
      userId,
      metadata: { by: "operator" },
    });
    await hooks.beforeDeleteUser(userId);
    await bestEffort(
      "account deletion device revocation",
      revokeUserDevices(
        {
          prisma,
          devices: new UserDevices({
            prisma,
            forwardSecret: userDeviceForwardSecret(env.encryptionKey),
          }),
        },
        userId,
      ),
    );
    // The user row cascades to authentication accounts and sessions in the same transaction.
    const deleted = await prisma.$transaction(async (tx) => {
      await clearAccountIdentity(tx, userId);
      return tx.user.deleteMany({ where: { id: userId } });
    });
    if (deleted.count) {
      await recordSecurityEvent({
        type: "auth.account.deleted",
        userId,
        metadata: { by: "operator" },
      });
      // The user row took the memberships with it, so address the completion to their
      // organizations explicitly. Guests' account activity stays out of their hosts' logs.
      await Promise.all(
        organizationIds.map((organizationId) =>
          recordAuditEvent({
            action: "auth.account.deleted",
            actor: { type: "system", label: "operator" },
            organizationId,
            target: { type: "user", id: userId },
          }),
        ),
      );
      await hooks.afterDeleteUser(userId);
    }
  } finally {
    await starter.stop();
    await jobs.close();
    await realtime.close();
  }
}
