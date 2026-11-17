import type {
  AdapterContext,
  AgentHomeStore,
  ArtifactStore,
  JobPublisher,
  SandboxProvider,
  SecretStore,
} from "@rakazo/adapter-kit";
import type { MemoryProviderResolver } from "@rakazo/adapters";
import {
  destroyBot,
  forgetPageShareSecrets,
  removeAgentHome,
  toComputerRef,
} from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { HeldLease, PrismaClient } from "@rakazo/db";
import {
  assertLeaseHeld,
  assertSpaceDeletable,
  claimSpaceDeletionForMember,
  deleteClaimedSpaceForMember,
  LeaseHeldError,
  LeaseLostError,
  listClaimedSpaceBots,
  listClaimedSpaceComputers,
  recordComputerRunEnd,
  releaseSpaceDeletionClaim,
  renewSpaceDeletionClaim,
  SPACE_DELETION_CLAIM_TIMEOUT_MS,
  SpaceDeletionInProgressError,
  withLease,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { rehomeItemsLeaving } from "./availability.js";

/** Bound for one bot or sandbox teardown. Providers may ignore the abort signal, so without a
 * deadline a hung destroy would keep the lease renewed forever and block recovery. */
const SPACE_TEARDOWN_TIMEOUT_MS = 120_000;

function spaceTeardownTimeoutMs(): number {
  const override = Number(process.env.SPACE_TEARDOWN_TIMEOUT_MS ?? "");
  return Number.isFinite(override) && override > 0 ? override : SPACE_TEARDOWN_TIMEOUT_MS;
}

export type SpaceDeletionDeps = {
  prisma: PrismaClient;
  sandbox: SandboxProvider;
  home: AgentHomeStore;
  jobs: JobPublisher;
  memoryProviders: MemoryProviderResolver;
  artifacts: ArtifactStore;
  dataDir: string;
  messagingInstallations?: Parameters<typeof destroyBot>[0]["messagingInstallations"];
  /** Removes deleted page links' tokens from a remote secret store. */
  secrets?: Pick<SecretStore, "delete">;
};

/**
 * The owner-only rules live in the db layer. One attempt at a time holds the Space's lease, and
 * renewing it keeps the Space's claim fresh, since account and organization deletion and the
 * previous release judge a claim by its age. A worker that dies mid-way leaves the Space claimed;
 * once the lease and claim lapse, deleting again resumes from what is left.
 */
export async function deleteSpaceWithContent(
  deps: SpaceDeletionDeps,
  actor: Pick<Actor, "spaceId" | "userId">,
  spaceId: string,
  signal?: AbortSignal,
): Promise<{ activeSpaceId: string }> {
  const deleteInput = { currentSpaceId: actor.spaceId, userId: actor.userId, spaceId };
  // A caller who may not delete it takes no lease on it, and never learns whether one is held.
  await assertSpaceDeletable(deps.prisma, deleteInput);
  const context = (botId?: string): AdapterContext => ({
    operationId: `spaces.remove:${spaceId}`,
    traceId: `spaces.remove:${spaceId}`,
    spaceId,
    userId: actor.userId,
    ...(botId ? { botId } : {}),
    signal: new AbortController().signal,
  });
  // A hung teardown stops the attempt here: renewal stops, and the claim and lease lapse unless
  // the teardown settles first, since it may still reach the provider.
  const timedOut = new AbortController();
  let claimId: string | undefined;
  // Until the first teardown, a fresh claim goes back on failure. A recovered one never does: the
  // attempt before may have torn something down, so only a finished deletion unblocks the Space.
  let releasable = false;
  let leaseSignal: AbortSignal | undefined;
  const keepClaim = async () => {
    if (!claimId) return true;
    if (await renewSpaceDeletionClaim(deps.prisma, { ...deleteInput, claimId })) return true;
    // Gone means this attempt deleted it, and only its file cleanup remains.
    return (await deps.prisma.space.count({ where: { id: spaceId } })) === 0;
  };
  const work = async (lease: HeldLease) => {
    leaseSignal = lease.signal;
    const claim = await claimSpaceDeletionForMember(deps.prisma, deleteInput);
    claimId = claim.claimId;
    releasable = !claim.recovered;
    // Cut off while the claim was being taken: nothing was torn down, so a fresh claim goes back
    // now rather than holding off the next attempt until it lapses.
    if (lease.signal.aborted) {
      if (releasable) await releaseSpaceDeletionClaim(deps.prisma, { ...deleteInput, claimId });
      lease.signal.throwIfAborted();
    }
    const claimedInput = { ...deleteInput, claimId: claim.claimId };
    // Teardown may reach a remote service even when it fails, so from the first one only a
    // finished deletion may unblock the Space, and work resumed after the lease is lost or the
    // teardown timed out starts nothing new.
    const teardown = async (destroy: () => Promise<unknown>, timeoutMessage: string) => {
      lease.signal.throwIfAborted();
      releasable = false;
      const timer = setTimeout(
        () => timedOut.abort(new Error(timeoutMessage)),
        spaceTeardownTimeoutMs(),
      );
      try {
        await destroy();
      } finally {
        clearTimeout(timer);
      }
      lease.signal.throwIfAborted();
    };

    for (const bot of await listClaimedSpaceBots(deps.prisma, claimedInput)) {
      try {
        await teardown(
          () =>
            destroyBot({ ...deps, secretStore: deps.secrets }, bot, context(bot.id), {
              deleteMemories: true,
              strictTeardown: true,
            }),
          "Space bot teardown timed out",
        );
      } catch (error) {
        // A takeover worker may have finished this bot first.
        if (lease.signal.aborted) throw error;
        const remaining = await deps.prisma.bot.findUnique({
          where: { id: bot.id },
          select: { id: true },
        });
        if (remaining) throw error;
      }
    }
    for (const computer of await listClaimedSpaceComputers(deps.prisma, claimedInput)) {
      await teardown(
        () => deps.sandbox.destroy(toComputerRef(computer), context(computer.homeKey)),
        "Space sandbox teardown timed out",
      );
      // Never clear a provider handle after this worker loses its lease or claim.
      await deps.prisma.$transaction(async (tx) => {
        await assertLeaseHeld(tx, lease);
        await tx.computer.updateMany({
          where: {
            spaceId,
            homeKey: computer.homeKey,
            providerRef: computer.providerRef,
            space: { deletionClaimId: claim.claimId },
          },
          data: { state: "stopped", providerRef: null },
        });
      });
      await recordComputerRunEnd(deps.prisma, computer, "deleted");
    }
    lease.signal.throwIfAborted();
    await rehomeItemsLeaving(deps.prisma, spaceId);
    const deleted = await deleteClaimedSpaceForMember(deps.prisma, { ...claimedInput, lease });
    // Cleaned up here rather than after the lease, so a deletion that commits just as the attempt
    // is cut off still removes what it left behind. The rows are gone and leftover stored files are
    // unreachable, so cleanup failures only log.
    const cleanup = await Promise.allSettled([
      ...deleted.artifactKeys.map((storageKey) => deps.artifacts.remove(storageKey, context())),
      ...deleted.homeKeys.map((homeKey) => removeAgentHome(deps.home, homeKey, deps.dataDir)),
    ]);
    for (const result of cleanup) {
      if (result.status === "rejected") getLogger().error("space file cleanup", result.reason);
    }
    if (deps.secrets) await forgetPageShareSecrets(deps.secrets, deleted.pageShareSecrets);
    return deleted.id;
  };

  let activeSpaceId: string;
  try {
    activeSpaceId = await withLease(
      deps.prisma,
      `space-deletion:${spaceId}`,
      { ttlMs: SPACE_DELETION_CLAIM_TIMEOUT_MS, signal: timedOut.signal, onRenew: keepClaim },
      work,
    );
  } catch (error) {
    // Work cut off by a timeout or a lost lease may still be running, so its claim is left to
    // lapse. Otherwise the work has settled, so a fresh claim nothing was torn down under goes back.
    if (claimId && releasable && !leaseSignal?.aborted && !signal?.aborted) {
      await releaseSpaceDeletionClaim(deps.prisma, { ...deleteInput, claimId }).catch(
        (releaseError) => {
          getLogger().error("space deletion claim release failed", releaseError);
        },
      );
    }
    if (error instanceof LeaseHeldError || error instanceof LeaseLostError)
      throw new SpaceDeletionInProgressError();
    throw error;
  }
  return { activeSpaceId };
}
