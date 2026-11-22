import type { AgentContextStrategy } from "@rakazo/adapter-kit";
import type { RunStatus } from "@rakazo/contracts";
import { BACKGROUND_HELPER_TRIGGER, isTerminal } from "@rakazo/core";
import {
  accountDeactivated,
  appendEventInTransaction,
  cancelDeactivatedAccountRuns,
  cancelRunsInTransaction,
  createPendingSteeringRun,
  databaseOutage,
  RunHistoryWriteError,
  readRunTimingFields,
  retryWhileDatabaseUnavailable,
  settleReleasedTakeoverCards,
} from "@rakazo/db";
import { bestEffort, enrichLogContext, getLogger } from "@rakazo/logging";
import type { ComputerExecutionLease } from "../../computers/computer-lifecycle.js";
import {
  acquireComputerExecutionLease,
  acquireDedicatedScreenLeaseFence,
  ComputerBusyError,
  EXECUTION_LEASE_MS,
  releaseComputerExecutionLease,
  renewComputerExecutionLease,
} from "../../computers/computer-lifecycle.js";
import { lateRoutineRunDueAt } from "../../routines/routine-lateness.js";
import type {
  RunComputerUseState,
  RunLeaseState,
  RunningHelper,
  RunProviders,
} from "../assembly/run-context.js";
import { settleRunningHelpers } from "../assembly/run-context.js";
import { withRunLease } from "../assembly/run-messages.js";
import type { ExecutorDeps } from "../executor/executor-deps.js";
import type { resolveConnectedRunModel } from "../turn/run-model.js";
import type { TakeoverContinuePlan } from "../turn/takeover-resume.js";
import { takeoverContinuePlan } from "../turn/takeover-resume.js";
import { wakeRun } from "../wakeups/wake-run.js";
import { claimRun, finishRunAttempt, renewRunLease, requeueComputerRun } from "./run-lifecycle.js";

const RUN_HEARTBEAT_MS = 60_000;

/** What createRunExecutor builds once; every run it continues shares these. */
export interface RunExecutorServices extends Omit<RunProviders, "cloudAgent"> {
  /** The dependencies as they were passed in, before createRunExecutor wraps run finalization. */
  executorDeps: ExecutorDeps;
  contextStrategy: AgentContextStrategy;
  resolveConnectedModel: (
    ...args: Parameters<typeof resolveConnectedRunModel> extends [ExecutorDeps, ...infer Rest]
      ? Rest
      : never
  ) => ReturnType<typeof resolveConnectedRunModel>;
}

export async function findContinuableRun(
  deps: ExecutorDeps,
  endRunConnectorState: (runId: string) => void,
  runId: string,
) {
  // A stopping process must not claim work it cannot finish. The row stays
  // queued or expired for a worker that is still running.
  if (deps.stoppingSignal?.aborted || deps.shutdownSignal?.aborted) return;
  const run = await deps.prisma.run.findUnique({
    where: { id: runId },
    include: { routine: { select: { name: true, inChat: true } } },
  });
  if (!run) return;
  // Logs and security events raised by this run's tools name its account and space.
  enrichLogContext({
    "run.id": runId,
    "bot.id": run.botId,
    "thread.id": run.threadId,
    "space.id": run.spaceId,
    ...(run.userId ? { "user.id": run.userId } : {}),
  });
  if (isTerminal(run.status as RunStatus)) {
    // Finalized elsewhere (cancelled while waiting, another worker): this
    // worker's run-scoped state for it may end now; until a next touch, the
    // connector's own idle bound holds it.
    endRunConnectorState(runId);
    return;
  }
  // Every way work reaches a bot ends here, so a deactivated account's run stops before it starts.
  if (await accountDeactivated(deps.prisma, run.userId)) {
    // Nothing cancelled: the owner is back (or the run already ended), so carry on.
    if (await cancelDeactivatedAccountRuns(deps.prisma, deps.events, run.userId, runId)) return;
  }
  if (await cancelRunOfFormerMember(deps, run)) return;
  return run;
}

type ContinuableRun = NonNullable<Awaited<ReturnType<typeof findContinuableRun>>>;

export async function claimRunAttempt(deps: ExecutorDeps, run: ContinuableRun, workerId: string) {
  const takeover = takeoverContinuePlan(run);
  // The run was looked up a moment ago; a process that began stopping since then claims nothing.
  if (deps.stoppingSignal?.aborted || deps.shutdownSignal?.aborted) return;
  const claimed = await claimRun(deps, run, workerId);
  if (!claimed) return;
  const claim = { run, runId: run.id, workerId, ...claimed, takeover };
  let started: Awaited<ReturnType<typeof startClaimedAttempt>>;
  let setupFailure: { error: unknown } | undefined;
  try {
    started = await startClaimedAttempt(deps, claim);
    if (!started) return;
  } catch (error) {
    // Nothing renews or releases the claim yet; an attempt lets the caller retry a failed setup.
    setupFailure = { error };
    started = {
      computerLease: null,
      // The failed write may have committed with its reply lost; a second row would stay running.
      attempt: await retryWhileDatabaseUnavailable(
        async () =>
          (await deps.prisma.attempt.findFirst({
            where: { runId: run.id, fence: claimed.fence },
          })) ??
          (await deps.prisma.attempt.create({
            data: { runId: run.id, fence: claimed.fence, status: "running" },
          })),
        { source: "run setup", signal: deps.shutdownSignal },
      ),
      executionStartedAt: claimed.current.startedAt ?? new Date(),
      firstLateSince: undefined,
    };
  }
  const helperConversation =
    run.trigger === BACKGROUND_HELPER_TRIGGER && run.sourceMessageId
      ? await deps.prisma.message.findFirst({
          where: { id: run.sourceMessageId, botId: run.botId, thread: { spaceId: run.spaceId } },
          select: { threadId: true },
        })
      : null;
  return {
    ...claim,
    ...started,
    setupFailure,
    helperConversationThreadId: helperConversation?.threadId,
  };
}

type ClaimedRun = NonNullable<Awaited<ReturnType<typeof claimRun>>> & {
  run: ContinuableRun;
  runId: string;
  workerId: string;
  takeover: TakeoverContinuePlan;
};

/** Undefined when the run went back to waiting for its computer, or a newer claim owns it. */
async function startClaimedAttempt(
  deps: ExecutorDeps,
  { run, runId, workerId, fence, current, takeover }: ClaimedRun,
) {
  const { resumeCheckpoint, heldForTakeover, takeoverResume } = takeover;
  await deps.events.publishSpaceChange?.(run.spaceId, "runs");
  const leaseTarget = await deps.prisma.bot.findUniqueOrThrow({
    where: { id: run.botId },
    select: {
      computerId: true,
      computerSwitching: true,
      computer: { select: { scope: true } },
    },
  });
  if (!leaseTarget.computerId) throw new Error("Bot has no computer");
  // Only takeover resumes need the computer before model work starts.
  const needsComputerNow = heldForTakeover || Boolean(takeoverResume);
  if (leaseTarget.computerSwitching) {
    await requeueComputerRun(deps, runId, workerId, fence, resumeCheckpoint, heldForTakeover);
    return;
  }
  if (takeoverResume) {
    try {
      await settleReleasedTakeoverCards(
        deps.prisma,
        {
          spaceId: run.spaceId,
          threadId: run.threadId,
          botId: run.botId,
          runId,
          reason: takeoverResume.checkpoint,
          lease: { owner: workerId, fence },
        },
        (threadId, seq) => deps.events.notify(threadId, seq),
      );
    } catch (error) {
      // A newer claim owns the run and its takeover cards.
      if (error instanceof RunHistoryWriteError) return;
      throw error;
    }
  }
  let computerLease: ComputerExecutionLease | null = null;
  try {
    computerLease = !needsComputerNow
      ? null
      : await acquireComputerExecutionLease(deps.prisma, {
          computerId: leaseTarget.computerId,
          runId,
          botId: run.botId,
          workerId,
          runFence: fence,
        });
    if (!computerLease && needsComputerNow && leaseTarget.computer?.scope === "dedicated") {
      computerLease = await acquireDedicatedScreenLeaseFence(deps.prisma, {
        computerId: leaseTarget.computerId,
        runId,
        botId: run.botId,
        workerId,
        runFence: fence,
      });
    }
  } catch (error) {
    if (!(error instanceof ComputerBusyError)) throw error;
    // Maintenance or suspension sends no release, so only a held lease waits for one.
    const heldByAnotherRun = await deps.prisma.computerExecutionLease.findFirst({
      where: {
        computerId: leaseTarget.computerId,
        botId: run.botId,
        runId: { not: runId },
        expiresAt: { gt: new Date() },
      },
      select: { id: true },
    });
    await requeueComputerRun(
      deps,
      runId,
      workerId,
      fence,
      resumeCheckpoint,
      heldForTakeover,
      Boolean(heldByAnotherRun),
    );
    return;
  }
  let attempt: { id: string };
  // Resumed attempts keep the first start, so lateness reflects when the run began.
  const executionStartedAt = current.startedAt ?? new Date();
  // Classified with the first start, so a retry, resume or later schedule edit keeps it.
  let firstLateSince: Date | undefined;
  if (!current.startedAt && run.trigger === "routine" && run.routineId && run.clientNonce) {
    try {
      const routine = await deps.prisma.routine.findUnique({
        where: { id: run.routineId },
        select: { crons: true, timezone: true },
      });
      if (routine) firstLateSince = lateRoutineRunDueAt(run, routine, executionStartedAt);
    } catch {
      // Lateness is optional context; a lookup failure must not prevent a run.
    }
  }
  try {
    // Ordinary turns start now and claim their computer when a tool first needs it.
    const executionStarted = await deps.prisma.run.updateMany({
      where: { id: runId, status: "running", leaseOwner: workerId, leaseFence: fence },
      data: { startedAt: executionStartedAt, lateSince: firstLateSince },
    });
    if (executionStarted.count !== 1) {
      await bestEffort(
        "release computer execution lease",
        releaseComputerExecutionLease(deps.prisma, computerLease),
      );
      return;
    }
    getLogger().info("run.execution_started", {
      ...(await readRunTimingFields(deps.prisma, runId)),
    });
    attempt = await deps.prisma.attempt.create({
      data: { runId, fence, status: "running" },
    });
  } catch (error) {
    await bestEffort(
      "release computer execution lease",
      releaseComputerExecutionLease(deps.prisma, computerLease),
    );
    throw error;
  }
  return { computerLease, attempt, executionStartedAt, firstLateSince };
}

type RunClaim = NonNullable<Awaited<ReturnType<typeof claimRunAttempt>>>;

/**
 * What this process holds for one attempt, from the claim until its release: the run and
 * computer leases, the heartbeat that renews them, and what setup has done so far.
 */
export interface RunHold extends RunClaim {
  /** Carries the attempt's lease, so a newer claim of the run rejects this attempt's history writes. */
  deps: ExecutorDeps;
  lease: RunLeaseState;
  computerUse: RunComputerUseState;
  runningHelpers: Map<string, RunningHelper>;
  settleHelpers: () => Promise<void>;
  heartbeat: ReturnType<typeof setInterval>;
  stopHeartbeatAfterCompletion: () => void;
  /** Every value redacted from what the run shows or stores. Grows during setup and the turn. */
  secrets: string[];
  /** Replaced when a takeover is released while the turn is being assembled. */
  takeover: TakeoverContinuePlan;
  /** Empty until assembly opens the run's abort signal; a lost lease aborts whatever is there. */
  abort: { controller: AbortController | null };
  detachShutdown: (() => void) | undefined;
  dispatchHandedOff: boolean;
}

export function holdRun(baseDeps: ExecutorDeps, claim: RunClaim): RunHold {
  const { run, runId, workerId, fence } = claim;
  // A newer claim of this run now rejects this attempt's history writes.
  const deps = withRunLease(
    baseDeps,
    runId,
    { owner: workerId, fence },
    claim.helperConversationThreadId,
  );
  const lease: RunLeaseState = {
    valid: true,
    completed: false,
    lastCheckAt: 0,
    retainComputer: false,
    renewedAt: Date.now(),
    handedBack: false,
  };
  const computerUse: RunComputerUseState = {
    reason: "none",
    tool: undefined,
    screenRelease: undefined,
  };
  const abort: RunHold["abort"] = { controller: null };
  const runningHelpers = new Map<string, RunningHelper>();
  const settleHelpers = () => settleRunningHelpers(deps, run, runningHelpers);

  const heartbeat = setInterval(() => {
    if (lease.completed) return;
    void Promise.all([
      renewRunLease(deps, runId, workerId, fence),
      renewComputerExecutionLease(deps.prisma, hold.computerLease),
    ])
      .then(([runRenewed, computerRenewed]) => {
        if (lease.completed) return;
        if (runRenewed && computerRenewed) {
          lease.renewedAt = Date.now();
          return;
        }
        lease.valid = false;
        abort.controller?.abort();
      })
      .catch((error) => {
        if (lease.completed) return;
        // Both leases outlast a short failover; the next beat renews them. Once they could
        // have expired, another worker may claim the run, so this attempt stops.
        if (
          databaseOutage.failed(error, "run lease renewal") &&
          Date.now() < lease.renewedAt + EXECUTION_LEASE_MS - RUN_HEARTBEAT_MS
        )
          return;
        lease.valid = false;
        abort.controller?.abort();
      });
  }, RUN_HEARTBEAT_MS);
  heartbeat.unref?.();
  const stopHeartbeatAfterCompletion = () => {
    lease.completed = true;
    clearInterval(heartbeat);
  };

  const runSecrets = [...deps.secrets];
  const hold: RunHold = {
    ...claim,
    deps,
    lease,
    computerUse,
    runningHelpers,
    settleHelpers,
    heartbeat,
    stopHeartbeatAfterCompletion,
    secrets: runSecrets,
    abort,
    detachShutdown: undefined,
    dispatchHandedOff: false,
  };
  return hold;
}

export async function releaseRunHold(hold: RunHold, endRunConnectorState: (runId: string) => void) {
  const {
    deps,
    run,
    runId,
    workerId,
    fence,
    attempt,
    lease,
    computerUse,
    computerLease,
    heartbeat,
    settleHelpers,
  } = hold;
  getLogger().info("run.computer", {
    "run.id": runId,
    trigger: run.trigger,
    reason: computerUse.reason,
    tool: computerUse.tool,
    ready: Boolean(computerUse.screenRelease),
  });
  hold.detachShutdown?.();
  clearInterval(heartbeat);
  await finishRunAttempt(
    deps,
    run,
    { id: attempt.id, workerId, fence },
    { lease, computerUse, computerLease },
    { endRunConnectorState, settleHelpers },
  );
}

/**
 * A run acts with its sender's accounts, so it must not start or resume once they have left
 * the Space. Leaving cancels their runs; this closes the gap for anything that slipped past.
 */
async function cancelRunOfFormerMember(
  deps: ExecutorDeps,
  run: {
    id: string;
    spaceId: string;
    userId: string;
    threadId: string;
    botId: string;
  },
): Promise<boolean> {
  const member = await deps.prisma.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId: run.spaceId, userId: run.userId } },
    select: { id: true },
  });
  if (member) return false;
  const cancelled = await deps.prisma.$transaction(async (tx) => {
    const current = await tx.run.findUnique({
      where: { id: run.id },
      select: {
        id: true,
        taskId: true,
        userId: true,
        spaceId: true,
        status: true,
      },
    });
    if (!current || isTerminal(current.status as RunStatus)) return null;
    const [stopped] = await cancelRunsInTransaction(tx, [current], new Date());
    if (!stopped) return null;
    const event = await appendEventInTransaction(tx, {
      spaceId: run.spaceId,
      threadId: run.threadId,
      botId: run.botId,
      runId: run.id,
      type: "run.cancelled",
      payload: {},
    });
    // Remaining members' messages waited behind this run; give them their own.
    const continuationId = await createPendingSteeringRun(tx, run);
    return { seq: event.seq, continuationId };
  });
  if (!cancelled) return true;
  await deps.events.notify(run.threadId, cancelled.seq);
  if (cancelled.continuationId) await wakeRun(deps.jobs, cancelled.continuationId);
  return true;
}
