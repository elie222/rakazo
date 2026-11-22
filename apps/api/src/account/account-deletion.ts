import type { AdapterContext } from "@rakazo/adapter-kit";
import {
  destroyBot,
  forgetPageShareSecrets,
  removeAgentHome,
  removeDeletedBotsFromLegacyTeamHome,
  toComputerRef,
} from "@rakazo/adapters";
import { requestDeadline } from "@rakazo/core";
import type { HeldLease, Prisma, ThreadEvents } from "@rakazo/db";
import {
  assertLeaseHeld,
  assertNoOwnedOrganizationWithMembers,
  assertOrganizationOwner,
  claimOrganizationForDeletion,
  claimSpacesLeavingWithAccount,
  deleteClaimedSpace,
  deleteEmptyOrganization,
  deletePageShareSecrets,
  expireSpaceDeletionClaims,
  keepOrganizationTrialUse,
  LeaseHeldError,
  leaveInvitedSpaces,
  listStalledOrganizationDeletions,
  recordAuditEvent,
  recordComputerRunEnd,
  releaseOrganizationDeletionClaim,
  renewAccountDeletionClaims,
  restoreSpaceDeletionClaims,
  runAsSystem,
  SPACE_DELETION_CLAIM_TIMEOUT_MS,
  SpaceDeletionInProgressError,
  setOrganizationDeletionLease,
  withLease,
  withTransactionRetry,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { BillingService } from "../billing/billing.js";
import type { SpaceDeletionDeps } from "../spaces/space-deletion.js";
import { disconnectMeetingCalendarsForDeletion } from "../spaces/space-deletion.js";
import { afterSpaceDeparture } from "../spaces/space-departure.js";

/** Bounds one account or organization deletion attempt. Providers may ignore the abort signal, so
 * without it a hung teardown would keep renewing the lease and no later attempt could resume. */
const DELETION_TIMEOUT_MS = 15 * 60_000;

/**
 * In shared spaces, the account's bot folders also live on the space's Team Computer from before
 * each person got their own. Each sandbox is destroyed at its provider before its row goes, so a
 * failure keeps the handle and deleting again resumes from what is left. One attempt at a time
 * holds the account's lease, and renewing it keeps its Spaces' claims fresh, since space and
 * organization deletion and the previous release judge a claim by its age.
 */
export async function deleteAccountContent(
  deps: SpaceDeletionDeps & {
    events: ThreadEvents;
    billing?: Pick<BillingService, "cancelForDeletedUser">;
  },
  userId: string,
): Promise<void> {
  const deadline = requestDeadline(DELETION_TIMEOUT_MS, "Account deletion timed out");
  let claim: Awaited<ReturnType<typeof claimSpacesLeavingWithAccount>> | undefined;
  let stage = "preflight" as "preflight" | "teardown" | "done";
  let leaseSignal: AbortSignal | undefined;
  // Given up because someone joined: another deletion may claim them, and that is no takeover.
  const released = new Set<string>();
  /** Lets the next attempt start at once: nothing of this one is left running. */
  const handBack = async (taken: NonNullable<typeof claim>) => {
    const { claimId, attemptId, takenOver } = taken;
    // Before teardown, give back only what this attempt claimed, keeping claims an earlier
    // attempt left and other deletions' markers. From teardown on, a retry takes over at once.
    if (stage === "preflight")
      await restoreSpaceDeletionClaims(deps.prisma, { claimId, attemptId }, takenOver);
    else await expireSpaceDeletionClaims(deps.prisma, { claimId, attemptId });
  };
  const work = async (lease: HeldLease) => {
    leaseSignal = lease.signal;
    const taken = await claimSpacesLeavingWithAccount(deps.prisma, userId);
    // Cut off while the claims were being taken: the caller has gone, so they go back now rather
    // than holding off the next attempt until they lapse.
    if (lease.signal.aborted) {
      await handBack(taken);
      lease.signal.throwIfAborted();
    }
    claim = taken;
    // Nobody can take an organization over yet, so its owner removes the others first. Checked
    // once the claims hold: a join waits for the claim on its organization's default Space, or is
    // refused by it, so nobody joins after this passes.
    await assertNoOwnedOrganizationWithMembers(deps.prisma, userId);
    const { claimId, spaceIds } = claim;
    lease.signal.throwIfAborted();
    await disconnectMeetingCalendarsForDeletion(deps, { userId });
    lease.signal.throwIfAborted();
    await disconnectClaimedSpaceCalendars(deps, spaceIds);
    lease.signal.throwIfAborted();
    // Cancel under the claims, so a checkout opened while another organization's cancellation
    // waits is refused by the deletion check instead of outliving the account.
    await deps.billing?.cancelForDeletedUser(userId);
    // Cut off during billing: billing has settled and nothing was torn down, so the claims go back
    // now. The caller may already have its error and skipped the hand-back below.
    if (lease.signal.aborted) {
      await handBack(claim);
      lease.signal.throwIfAborted();
    }
    stage = "teardown";
    const leaving = { OR: [{ userId }, { spaceId: { in: spaceIds } }] };
    // Then leave other people's Spaces, so what this account made there passes to their owners
    // instead of being torn down with it. None of them is claimed above: each keeps another full
    // member. As after leaving: tell members, stop the cancelled runs' work, free held screens,
    // and start others' waiting follow-ups.
    await leaveInvitedSpaces(deps.prisma, userId, (departure) =>
      afterSpaceDeparture(deps, { spaceId: departure.spaceId, userId }, departure),
    );
    lease.signal.throwIfAborted();
    await deleteClaimedSpaces(deps, {
      userId,
      operationId: `account-delete:${userId}`,
      claimId,
      spaceIds,
      soleMemberId: userId,
      bots: leaving,
      computers: leaving,
      signal: lease.signal,
      lease,
      onReleased: (spaceId) => released.add(spaceId),
    });
    stage = "done";

    // Pages in Spaces that stay go with the user row; their links' tokens leave the store now.
    const memberPageSecrets = await deps.prisma.$transaction(async (tx) => {
      await assertLeaseHeld(tx, lease);
      return deletePageShareSecrets(tx, { userId, spaceId: { notIn: spaceIds } });
    });
    if (deps.secrets) await forgetPageShareSecrets(deps.secrets, memberPageSecrets);

    // Bot deletion cleans these best-effort; here a failure fails the account deletion, and the
    // retry finds the ids again in bot_deletions.
    const deletions = await deps.prisma.botDeletion.findMany({
      where: { deletedByUserId: userId, spaceId: { notIn: spaceIds } },
      select: { id: true, spaceId: true },
    });
    const deletedBySpace = new Map<string, string[]>();
    for (const { id, spaceId } of deletions)
      deletedBySpace.set(spaceId, [...(deletedBySpace.get(spaceId) ?? []), id]);
    lease.signal.throwIfAborted();
    await settleAll(
      [...deletedBySpace].map(([spaceId, botIds]) =>
        removeDeletedBotsFromLegacyTeamHome(deps, spaceId, botIds),
      ),
    );
  };
  try {
    await withLease(
      deps.prisma,
      `account-deletion:${userId}`,
      {
        ttlMs: SPACE_DELETION_CLAIM_TIMEOUT_MS,
        signal: deadline.signal,
        onRenew: async () =>
          !claim ||
          renewAccountDeletionClaims(deps.prisma, {
            ...claim,
            spaceIds: claim.spaceIds.filter((spaceId) => !released.has(spaceId)),
          }),
      },
      work,
    );
  } catch (error) {
    if (error instanceof LeaseHeldError) throw new SpaceDeletionInProgressError();
    // Work cut off by the deadline or a lost lease may still be running, so the claims are left to
    // lapse or to the attempt that took them. Otherwise the work has settled and renewal stopped,
    // so nothing is left running and the next attempt may start at once.
    if (claim && stage !== "done" && !leaseSignal?.aborted) await handBack(claim);
    throw error;
  } finally {
    deadline.dispose();
  }
}

type OrganizationDeletionDeps = SpaceDeletionDeps & {
  billing?: Pick<BillingService, "cancelOrganizationSubscriptions">;
};

/**
 * Claiming hides the organization from the owner's list. Calendar cleanup and subscription
 * cancellation run before content teardown, and a failure there releases a fresh claim.
 * Any later failure leaves the Spaces claimed, and deleting again, or the sweep once the lease
 * lapses, finishes. One attempt at a time holds the organization's lease, and renewing it keeps
 * the Spaces' claim fresh too, since space and account deletion still judge a claim by its age.
 * Audit events keep no foreign key to their organization, so the record outlives it.
 */
export async function deleteOrganization(
  deps: OrganizationDeletionDeps,
  userId: string,
  organizationId: string,
  signal?: AbortSignal,
): Promise<void> {
  // A caller who may not delete it takes no lease on it, and never learns whether one is held.
  await assertOrganizationOwner(deps.prisma, { userId, organizationId });
  const organization = await deps.prisma.organization.findUnique({
    where: { id: organizationId },
    select: { name: true },
  });
  const deadline = requestDeadline(DELETION_TIMEOUT_MS, "Organization deletion timed out", signal);
  let claim: Awaited<ReturnType<typeof claimOrganizationForDeletion>> | undefined;
  let billingCancelled = false;
  let leaseSignal: AbortSignal | undefined;
  const keepClaim = async () => {
    if (!claim) return true;
    const at = new Date();
    if (
      await setOrganizationDeletionLease(deps.prisma, {
        organizationId,
        claimId: claim.claimId,
        at,
      })
    )
      return true;
    // No Space left means this attempt deleted them, and only its file cleanup and record remain,
    // still under the overall deadline; any left are another attempt's.
    return (await deps.prisma.space.count({ where: { organizationId } })) === 0;
  };
  /** Lets the next attempt start at once: nothing of this one is left running. */
  const handBack = async (taken: NonNullable<typeof claim>) => {
    const { claimId, fresh } = taken;
    if (fresh && !billingCancelled)
      await releaseOrganizationDeletionClaim(deps.prisma, { organizationId, claimId });
    else
      await setOrganizationDeletionLease(deps.prisma, { organizationId, claimId, at: new Date(0) });
  };
  const operationId = `organization-delete:${organizationId}`;
  const work = async (lease: HeldLease) => {
    leaseSignal = lease.signal;
    const taken = await claimOrganizationForDeletion(deps.prisma, { userId, organizationId });
    // Cut off while the claim was being taken: the caller has gone, so the claim goes back now
    // rather than holding off the next attempt until it lapses.
    if (lease.signal.aborted) {
      await handBack(taken);
      lease.signal.throwIfAborted();
    }
    claim = taken;
    const { claimId, spaceIds } = claim;
    // Work cut off by the deadline or a lost lease that resumes later starts nothing new: a later
    // attempt may own it.
    const stillLeased = () => lease.signal.throwIfAborted();
    await disconnectClaimedSpaceCalendars(deps, spaceIds);
    stillLeased();
    await keepOrganizationTrialUse(deps.prisma, organizationId);
    stillLeased();
    await deps.billing?.cancelOrganizationSubscriptions(organizationId);
    billingCancelled = true;
    stillLeased();
    const inOrganization = { spaceId: { in: spaceIds } };
    // The claim leaves the owner as its only member, so every Space goes: its files can go before
    // the rows that list them, and a failed removal is found again on retry.
    const artifacts = await deps.prisma.artifact.findMany({
      where: inOrganization,
      select: { spaceId: true, storageKey: true },
    });
    stillLeased();
    await settleAll(
      artifacts.map(({ spaceId, storageKey }) =>
        deps.artifacts.remove(
          storageKey,
          adapterContext(operationId, userId, spaceId, undefined, lease.signal),
        ),
      ),
    );
    await deleteClaimedSpaces(deps, {
      userId,
      operationId,
      claimId,
      spaceIds,
      organizationId,
      bots: inOrganization,
      computers: inOrganization,
      signal: lease.signal,
      lease,
    });
    // The organization went with its last Space; only one left without any is deleted here.
    // A deadlock on the cascade is tried again rather than leaving an empty organization behind.
    await withTransactionRetry(() =>
      deps.prisma.$transaction(async (tx) => {
        if (
          !(await tx.organization.findUnique({
            where: { id: organizationId },
            select: { id: true },
          }))
        )
          return;
        await assertLeaseHeld(tx, lease);
        await deleteEmptyOrganization(tx, organizationId);
      }),
    );
    await recordAuditEvent({
      action: "organization.deleted",
      actor: { type: "user", id: userId },
      organizationId,
      target: { type: "organization", id: organizationId, label: organization?.name ?? null },
    });
  };
  try {
    await withLease(
      deps.prisma,
      `organization-deletion:${organizationId}`,
      { ttlMs: SPACE_DELETION_CLAIM_TIMEOUT_MS, signal: deadline.signal, onRenew: keepClaim },
      work,
    );
  } catch (error) {
    if (error instanceof LeaseHeldError) throw new SpaceDeletionInProgressError();
    // Work cut off by the deadline or a lost lease may still be running, so the claim is left to
    // lapse or to the attempt that took it. Otherwise the work has settled and renewal stopped, so
    // nothing is left running and the next attempt may start at once.
    if (claim && !leaseSignal?.aborted) await handBack(claim);
    throw error;
  } finally {
    deadline.dispose();
  }
}

/** Finishes organization deletions that stopped part way, such as on a provider failure or restart. */
export function finishStalledOrganizationDeletions(
  deps: OrganizationDeletionDeps,
): (signal: AbortSignal) => Promise<void> {
  return (signal) =>
    runAsSystem("finish stalled organization deletions", async () => {
      // Each deletion holds its own lease and deadline, so a hung provider holds up no other.
      const stalled = await listStalledOrganizationDeletions(deps.prisma);
      await Promise.all(
        stalled.map(({ id, ownerId }) =>
          deleteOrganization(deps, ownerId, id, signal).catch((error) =>
            getLogger().error("stalled organization deletion failed", error),
          ),
        ),
      );
    });
}

function disconnectClaimedSpaceCalendars(deps: SpaceDeletionDeps, spaceIds: string[]) {
  return settleAll(
    spaceIds.map((spaceId) => disconnectMeetingCalendarsForDeletion(deps, { spaceId })),
  );
}

/** Tears down the bots and computers matched, then deletes the claimed Spaces and their files. */
async function deleteClaimedSpaces(
  deps: SpaceDeletionDeps,
  input: {
    userId: string;
    operationId: string;
    claimId: string;
    spaceIds: string[];
    soleMemberId?: string;
    /** Deletes the organization with its last Space. */
    organizationId?: string;
    /** Commits each Space's deletion only while this lease is held. */
    lease?: Pick<HeldLease, "key" | "fence">;
    bots: Prisma.BotWhereInput;
    computers: Prisma.ComputerWhereInput;
    signal?: AbortSignal;
    /** A Space someone else still belongs to is given up rather than deleted. */
    onReleased?: (spaceId: string) => void;
  },
): Promise<void> {
  const context = (spaceId: string, botId?: string) =>
    adapterContext(input.operationId, input.userId, spaceId, botId, input.signal);
  input.signal?.throwIfAborted();
  const bots = await deps.prisma.bot.findMany({
    where: input.bots,
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
  input.signal?.throwIfAborted();
  await settleAll(
    bots.map((bot) =>
      destroyBot({ ...deps, secretStore: deps.secrets }, bot, context(bot.spaceId, bot.id), {
        deleteMemories: true,
        strictTeardown: true,
      }),
    ),
  );

  const computers = await deps.prisma.computer.findMany({
    where: input.computers,
    select: {
      id: true,
      spaceId: true,
      homeKey: true,
      kind: true,
      providerRef: true,
      bots: { select: { id: true } },
    },
  });
  input.signal?.throwIfAborted();
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
      await deps.prisma.$transaction(async (tx) => {
        if (input.lease) await assertLeaseHeld(tx, input.lease);
        await tx.computer.deleteMany({
          where: { id: computer.id, providerRef: computer.providerRef, bots: { none: {} } },
        });
      });
    }),
  );

  for (const spaceId of input.spaceIds) {
    // Teardown abandoned at a deadline that finishes later leaves the rest to the next attempt.
    input.signal?.throwIfAborted();
    const deleted = await deleteClaimedSpace(deps.prisma, {
      spaceId,
      claimId: input.claimId,
      soleMemberId: input.soleMemberId,
      organizationId: input.organizationId,
      lease: input.lease,
    });
    if (!deleted) {
      input.onReleased?.(spaceId);
      continue;
    }
    const cleanup = await Promise.allSettled(
      deleted.artifactKeys.map((storageKey) => deps.artifacts.remove(storageKey, context(spaceId))),
    );
    for (const result of cleanup) {
      if (result.status === "rejected") getLogger().error("space file cleanup", result.reason);
    }
    if (deps.secrets) await forgetPageShareSecrets(deps.secrets, deleted.pageShareSecrets);
  }
}

function adapterContext(
  operationId: string,
  userId: string,
  spaceId: string,
  botId?: string,
  signal: AbortSignal = new AbortController().signal,
): AdapterContext {
  return {
    operationId,
    traceId: operationId,
    spaceId,
    userId,
    ...(botId ? { botId } : {}),
    signal,
  };
}

/** Runs every teardown, then fails with the first error so a retry finishes the rest. */
async function settleAll(work: Promise<unknown>[]) {
  const failed = (await Promise.allSettled(work)).find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failed) throw failed.reason;
}
