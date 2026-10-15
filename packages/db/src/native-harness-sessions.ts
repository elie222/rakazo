import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "./client.js";
import { resolveExecutionHandover } from "./execution-handover.js";
import {
  ExecutionProfileUnavailableError,
  resolveRunExecutionProfile,
} from "./execution-profiles.js";
import { IsolationError } from "./scope.js";

type NativeSessionScope = {
  spaceId: string;
  userId: string;
  botId: string;
  threadId: string;
  profileId: string;
  runId: string;
  leaseFence: number;
};

async function lockNativeSessionRun(tx: Prisma.TransactionClient, input: NativeSessionScope) {
  // Same lock order as clearThread: thread first, then run. A clear cannot race
  // session creation and a lease reassignment cannot race a checkpoint write.
  await tx.$queryRaw`
    SELECT id FROM threads WHERE id = ${input.threadId} AND "spaceId" = ${input.spaceId} FOR SHARE
  `;
  const runs = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM runs
    WHERE id = ${input.runId} AND "spaceId" = ${input.spaceId} AND "userId" = ${input.userId}
      AND "botId" = ${input.botId} AND "threadId" = ${input.threadId} AND "leaseFence" = ${input.leaseFence}
    FOR SHARE
  `;
  if (runs.length !== 1) {
    throw new ExecutionProfileUnavailableError(
      "The native session run lease is no longer current.",
    );
  }
}

/** Claim a scoped continuation. A crashed or interrupted session requires an explicit new session. */
export async function claimNativeHarnessSession(
  prisma: PrismaClient,
  input: NativeSessionScope & { startNewSession?: boolean; installationId?: string },
) {
  return prisma.$transaction(async (tx) => {
    await lockNativeSessionRun(tx, input);
    const run = await tx.run.findFirst({
      where: {
        id: input.runId,
        leaseFence: input.leaseFence,
        spaceId: input.spaceId,
        userId: input.userId,
        botId: input.botId,
        threadId: input.threadId,
        status: { in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"] },
      },
    });
    if (!run) throw new IsolationError();
    const resolved = await resolveRunExecutionProfile(tx, run);
    if (!resolved || resolved.profile.id !== input.profileId) throw new IsolationError();
    const accounts = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM user_model_credentials
      WHERE id = ${resolved.snapshot.credentialId} AND "userId" = ${input.userId}
        AND "secretId" = ${resolved.snapshot.credentialSecretId}
      FOR SHARE
    `;
    if (accounts.length !== 1) {
      throw new ExecutionProfileUnavailableError(
        "The account connection changed while the native session was being claimed.",
      );
    }
    const key = { botId: input.botId, threadId: input.threadId, profileId: input.profileId };
    const session = await tx.nativeHarnessSession.upsert({
      where: { botId_threadId_profileId: key },
      create: {
        ...key,
        spaceId: input.spaceId,
        userId: input.userId,
        credentialSecretId: resolved.snapshot.credentialSecretId,
      },
      update: {},
    });
    // A fresh, explicitly requested turn may reconstruct from Rakazo history. Never
    // restart the interrupted run itself or silently replay its uncertain side effects.
    const handover = await resolveExecutionHandover(tx, { ...input, id: input.runId });
    const profileChanged = Boolean(handover) && session.lastRunId !== input.runId;
    const credentialChanged = session.credentialSecretId !== resolved.snapshot.credentialSecretId;
    const previousRun =
      (input.startNewSession || credentialChanged || profileChanged) &&
      session.activeRunId &&
      session.activeRunId !== input.runId
        ? await tx.run.findFirst({
            where: { id: session.activeRunId, spaceId: input.spaceId, userId: input.userId },
            select: { status: true },
          })
        : null;
    const abandoned =
      previousRun && ["completed", "failed", "cancelled"].includes(previousRun.status);
    const resetForCredential =
      credentialChanged &&
      (!session.activeRunId || abandoned) &&
      session.interruptedRunId !== input.runId;
    const resetForProfile =
      profileChanged &&
      (!session.activeRunId || abandoned) &&
      session.interruptedRunId !== input.runId;
    if (profileChanged && !resetForProfile) {
      throw new ExecutionProfileUnavailableError(
        "The previous execution profile session is still active.",
      );
    }
    if (credentialChanged && !resetForCredential) {
      throw new ExecutionProfileUnavailableError(
        "The native session still belongs to a run using the previous account connection.",
      );
    }
    if (
      resetForCredential ||
      resetForProfile ||
      (input.startNewSession &&
        (abandoned || (session.interrupted && session.interruptedRunId !== input.runId)))
    ) {
      const epoch = randomUUID();
      const reset = await tx.nativeHarnessSession.updateMany({
        where: {
          id: session.id,
          activeRunId: session.activeRunId,
          activeLeaseFence: session.activeLeaseFence,
          credentialSecretId: session.credentialSecretId,
          ...(abandoned || resetForCredential || resetForProfile
            ? {}
            : { interrupted: true, interruptedRunId: { not: input.runId } }),
        },
        data: {
          interrupted: false,
          nativeSessionId: null,
          epoch,
          credentialSecretId: resolved.snapshot.credentialSecretId,
          interruptedRunId: null,
          activeRunId: null,
          activeLeaseFence: null,
        },
      });
      if (reset.count !== 1) {
        throw new ExecutionProfileUnavailableError(
          "The native session changed while it was being reset.",
        );
      }
      session.nativeSessionId = null;
      session.epoch = epoch;
      session.credentialSecretId = resolved.snapshot.credentialSecretId;
    }
    const computer = resolved.snapshot.computerId
      ? await tx.computer.findFirst({
          where: { id: resolved.snapshot.computerId, spaceId: input.spaceId, userId: input.userId },
        })
      : null;
    const cleanupScope =
      computer?.providerRef &&
      computer.kind === "docker" &&
      input.installationId &&
      /^[a-f0-9]{32}$/.test(input.installationId)
        ? {
            computerId: computer.id,
            computer: {
              id: computer.providerRef,
              providerRef: computer.providerRef,
              botId: computer.homeKey,
              kind: "docker",
            },
            botId: input.botId,
            request: {
              expectedInstallationId: input.installationId,
              sessionScope: {
                threadId: input.threadId,
                profileId: input.profileId,
                profileRevision: resolved.profile.revision,
                accountId: resolved.snapshot.credentialId,
                epoch: session.epoch,
              },
            },
          }
        : undefined;
    const claimed = await tx.nativeHarnessSession.updateMany({
      where: {
        id: session.id,
        spaceId: input.spaceId,
        userId: input.userId,
        interrupted: false,
        credentialSecretId: resolved.snapshot.credentialSecretId,
        OR: [
          { activeRunId: null },
          { activeRunId: input.runId, activeLeaseFence: input.leaseFence },
        ],
      },
      data: {
        activeRunId: input.runId,
        activeLeaseFence: input.leaseFence,
        lastRunId: input.runId,
        ...(cleanupScope ? { cleanupScope } : {}),
      },
    });
    if (claimed.count !== 1) {
      throw new ExecutionProfileUnavailableError(
        session.interrupted
          ? "The native session was interrupted. Start a new session before continuing."
          : "The native session is already in use by another run.",
      );
    }
    return {
      ...session,
      activeRunId: input.runId,
      activeLeaseFence: input.leaseFence,
      interrupted: false,
    };
  });
}

/** The active run is the fence: stale attempts cannot overwrite another run's session. */
export async function updateNativeHarnessSession(
  prisma: Pick<PrismaClient, "$transaction">,
  input: NativeSessionScope & {
    nativeSessionId?: string;
    outcome?: "completed" | "paused" | "interrupted";
  },
): Promise<void> {
  const updated = await prisma.$transaction(async (tx) => {
    await lockNativeSessionRun(tx, input);
    return tx.nativeHarnessSession.updateMany({
      where: {
        spaceId: input.spaceId,
        userId: input.userId,
        botId: input.botId,
        threadId: input.threadId,
        profileId: input.profileId,
        activeRunId: input.runId,
        activeLeaseFence: input.leaseFence,
      },
      data: {
        ...(input.nativeSessionId !== undefined ? { nativeSessionId: input.nativeSessionId } : {}),
        ...(input.outcome
          ? {
              activeRunId: null,
              activeLeaseFence: null,
              interrupted: input.outcome === "interrupted",
              interruptedRunId: input.outcome === "interrupted" ? input.runId : null,
            }
          : {}),
      },
    });
  });
  if (updated.count !== 1) {
    throw new ExecutionProfileUnavailableError(
      "The native session lease no longer belongs to this run.",
    );
  }
}
