import { randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/server";
import type { AdapterContext } from "@rakazo/adapter-kit";
import { computerControlExpireJobKey } from "@rakazo/adapter-kit";
import type { ComputerExecutionLease } from "@rakazo/adapters";
import {
  acquireComputerExecutionLease,
  anotherPersonHoldsControl,
  ComputerBusyError,
  clearInactiveUserComputerControl,
  computerSupportsUpdate,
  enqueueTakeoverContinuation,
  expireComputerControl,
  hasActiveComputerControl,
  holdsUserControl,
  isSandboxGoneError,
  releaseComputerExecutionLease,
  replaceComputer,
  revokeScreenControl,
  scheduleComputerSleep,
  screenLeaseIdForRun,
} from "@rakazo/adapters";
import type { Actor, ComputerReleaseReason, ComputerStatus } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { createRepos, IsolationError, recordComputerRunEnd, spaceIsShared } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { resolveBusyBotName, resolveControllerName, toComputerStatus } from "./computer-status.js";
import type { RouterDeps } from "./router.js";
import { computerContext } from "./routes/shared.js";

const BOOT_LEASE_RETRY_MS = 250;
const BOOT_LEASE_ATTEMPTS = 20;

/**
 * A run lets go of its computer in its executor's finally, a moment after the run ends. A boot
 * sent as the run finishes waits that moment out instead of being refused as busy.
 */
export async function acquireBootLease(
  prisma: PrismaClient,
  input: { computerId: string; runId: string; botId: string },
): Promise<ComputerExecutionLease | null> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await acquireComputerExecutionLease(prisma, input);
    } catch (error) {
      if (!(error instanceof ComputerBusyError) || attempt >= BOOT_LEASE_ATTEMPTS) throw error;
      if (!(await leaseHeldByFinishedRun(prisma, input))) throw error;
      await new Promise((resolve) => setTimeout(resolve, BOOT_LEASE_RETRY_MS));
    }
  }
}

async function leaseHeldByFinishedRun(
  prisma: PrismaClient,
  input: { computerId: string; botId: string },
): Promise<boolean> {
  const lease = await prisma.computerExecutionLease.findUnique({
    where: { computerId_botId: { computerId: input.computerId, botId: input.botId } },
    select: { runId: true, expiresAt: true },
  });
  if (!lease || lease.expiresAt.getTime() <= Date.now()) return false;
  const run = await prisma.run.findUnique({ where: { id: lease.runId }, select: { status: true } });
  return Boolean(run && !(ACTIVE_RUN_STATUSES as readonly string[]).includes(run.status));
}

export async function computerStatus(
  deps: RouterDeps,
  actor: Actor,
  botId: string,
): Promise<ComputerStatus> {
  const repos = createRepos(deps.prisma);
  let bot = await repos.getBot(actor, botId);
  if (await expireStaleComputerControl(deps, bot.computer)) {
    bot = await repos.getBot(actor, botId);
  }
  const [busyBotName, shared, controllerName] = await Promise.all([
    resolveBusyBotName(deps.prisma, {
      computerId: bot.computer?.id,
      botId,
      botName: bot.name,
    }),
    spaceIsShared(deps.prisma, actor.spaceId),
    resolveControllerName(deps.prisma, bot.computer, actor.userId),
  ]);
  return toComputerStatus(botId, bot.computer, busyBotName, shared, actor.userId, controllerName);
}

/** Whether this person holds this bot's user control, so they may drive its screen. */
export function holdsComputerControl(
  computer: Parameters<typeof hasActiveComputerControl>[0] & {
    controlBotId: string | null;
    controlUserId: string | null;
    userId?: string;
  },
  botId: string,
  actor: Actor,
): boolean {
  return (
    hasActiveComputerControl(computer) &&
    computer.controlBotId === botId &&
    holdsUserControl(computer, actor.userId)
  );
}

/** Members share a Space's computers, but only the person holding control can keep or end it. */
export function assertNotAnotherPersonsControl(
  computer: Parameters<typeof anotherPersonHoldsControl>[0],
  actor: Actor,
): void {
  if (anotherPersonHoldsControl(computer, actor.userId)) {
    throw new ORPCError("CONFLICT", { message: "Someone else is using this computer" });
  }
}

/** Hand the user's screen control for this bot back, continuing any run waiting on it. */
export async function releaseComputerControl(
  deps: RouterDeps,
  actor: Actor,
  botId: string,
  reason?: ComputerReleaseReason,
  expectedRunId?: string,
): Promise<void> {
  let bot = await createRepos(deps.prisma).getBot(actor, botId);
  if (!bot.computer) {
    if (expectedRunId !== undefined) return;
    throw new IsolationError();
  }
  const unopenedTakeover =
    expectedRunId !== undefined &&
    bot.computer.controlHolder === "none" &&
    bot.computer.controlBotId === null &&
    bot.computer.controlLeaseId === null &&
    bot.computer.controlRunId === expectedRunId;
  if (unopenedTakeover) {
    const released = await deps.events.finalizeComputerControlRelease({
      spaceId: actor.spaceId,
      computerId: bot.computer.id,
      botId: bot.id,
      runId: expectedRunId,
      leaseId: null,
      holder: "bot",
      reason: reason ?? "released",
    });
    if (released) {
      await enqueueTakeoverContinuation(deps.jobs, released.runId);
      scheduleComputerSleep(deps.jobs, bot.computer.id);
      return;
    }
    bot = await createRepos(deps.prisma).getBot(actor, botId);
    if (!bot.computer) return;
  }
  const controlBotId = bot.computer.controlBotId;
  const controlLeaseId = bot.computer.controlLeaseId;
  if (bot.computer.controlHolder !== "user" || !controlBotId || controlBotId !== bot.id) return;
  // Read with the lease released below, so control someone took meanwhile is never ended.
  if (!holdsUserControl(bot.computer, actor.userId)) return;
  if (expectedRunId !== undefined && bot.computer.controlRunId !== expectedRunId) return;
  if (!hasActiveComputerControl(bot.computer) || !controlLeaseId) {
    // Stale controlHolder=user. Prefer expiry (revokes provider control). If a lease id
    // remains after a failed revoke, keep it so reconciliation can retry.
    if (controlLeaseId) {
      await expireComputerControl(deps, bot.computer.id, controlLeaseId).catch(() => undefined);
    } else {
      await clearInactiveUserComputerControl(deps.prisma, bot.computer.id);
    }
    return;
  }
  await revokeScreenControl(
    deps,
    bot.computer,
    computerContext(actor, controlBotId, "screen.release"),
    controlLeaseId,
  );

  const released = await deps.events.finalizeComputerControlRelease({
    spaceId: actor.spaceId,
    computerId: bot.computer.id,
    botId: controlBotId,
    runId: bot.computer.controlRunId,
    leaseId: controlLeaseId,
    holder: "bot",
    reason: reason ?? "released",
  });
  if (!released) return;
  // The lease-specific key makes this cancellation safe after a replacement takeover.
  await deps.jobs
    .cancel(computerControlExpireJobKey(bot.computer.id, controlLeaseId))
    .catch((error) => {
      // The expired job is harmless after the lease is cleared, so do not report a
      // failed release after the transaction has committed.
      getLogger().error("computer control expiry cancellation", error);
    });

  await enqueueTakeoverContinuation(deps.jobs, released.runId);
  scheduleComputerSleep(deps.jobs, bot.computer.id);
}

export async function runComputerReplace(
  deps: RouterDeps,
  context: { actor: Actor },
  botId: string,
  mode: "recover" | "reset" | "update",
  operationId: string,
): Promise<ComputerStatus> {
  const repos = createRepos(deps.prisma);
  const bot = await repos.getBot(context.actor, botId);
  if (!bot.computer) throw new IsolationError();
  // Stopping, resetting or updating would end someone else's control of the screen.
  assertNotAnotherPersonsControl(bot.computer, context.actor);
  if (mode === "update" && !computerSupportsUpdate(bot.computer.kind)) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Computer update is not available on this device",
    });
  }
  const manualRunId = `${mode}:${randomUUID()}`;
  let lease: ComputerExecutionLease | null;
  try {
    lease = await acquireComputerExecutionLease(deps.prisma, {
      computerId: bot.computer.id,
      runId: manualRunId,
      botId: bot.id,
    });
  } catch (error) {
    if (error instanceof ComputerBusyError) {
      throw new ORPCError("CONFLICT", { message: "Computer is busy" });
    }
    throw error;
  }
  try {
    await replaceComputer(
      deps,
      bot.computer.id,
      mode,
      {
        ...computerContext(context.actor, bot.id, operationId),
        screenLeaseId: screenLeaseIdForRun(lease, manualRunId),
      },
      "none",
      undefined,
      { handBackIdleTakeover: true },
    );
    scheduleComputerSleep(deps.jobs, bot.computer.id);
  } catch (error) {
    if (error instanceof ComputerBusyError) {
      throw new ORPCError("CONFLICT", { message: "Computer is busy" });
    }
    throw error;
  } finally {
    await releaseComputerExecutionLease(deps.prisma, lease);
  }
  return computerStatus(deps, context.actor, botId);
}

export async function expireStaleComputerControl(
  deps: RouterDeps,
  computer:
    | (NonNullable<Parameters<typeof hasActiveComputerControl>[0]> & {
        id: string;
        controlHolder?: string;
      })
    | null
    | undefined,
): Promise<boolean> {
  if (!computer || hasActiveComputerControl(computer)) return false;
  if (computer.controlHolder !== "user") {
    // Holder "none" with a surviving lease id is a revoke that failed mid-expiry;
    // retry it so the row does not sit busy forever.
    if (computer.controlLeaseId) {
      await expireComputerControl(deps, computer.id, computer.controlLeaseId).catch(
        () => undefined,
      );
      return true;
    }
    return false;
  }
  const leaseId = computer.controlLeaseId;
  // Keep a failed revoke's lease id so reconciliation can retry provider shutdown.
  if (leaseId) {
    await expireComputerControl(deps, computer.id, leaseId).catch(() => undefined);
    return true;
  }
  return clearInactiveUserComputerControl(deps.prisma, computer.id).catch(() => false);
}

/** When the user already holds control during waiting_takeover, bind controlRunId so
 * takeoverRequested becomes true and release can resume the waiting run. */
export async function bindWaitingTakeoverToControl(
  deps: RouterDeps,
  input: {
    spaceId: string;
    threadId: string | null | undefined;
    botId: string;
    computerId: string;
    controlLeaseId: string;
    controlRunId: string | null;
  },
): Promise<void> {
  await deps.prisma.$transaction(async (tx) => {
    // Lock the execution lease so a reclaimed fence/run cannot be bound by a stale read.
    const locked = await tx.$queryRaw<Array<{ runId: string; fence: number }>>`
      SELECT "runId", fence FROM computer_execution_leases
      WHERE "computerId" = ${input.computerId} AND "botId" = ${input.botId}
      FOR UPDATE`;
    const executionLease = locked[0];
    if (!executionLease) return;

    const executionRun = await tx.run.findUnique({
      where: { id: executionLease.runId },
      select: { botId: true, status: true },
    });
    const waitingForTakeover =
      executionRun?.botId === input.botId && executionRun.status === "waiting_takeover";
    if (!waitingForTakeover) return;
    if (input.controlRunId === executionLease.runId) return;

    const leaseStillCurrent = await tx.computerExecutionLease.count({
      where: {
        computerId: input.computerId,
        botId: input.botId,
        runId: executionLease.runId,
        fence: executionLease.fence,
      },
    });
    if (leaseStillCurrent !== 1) return;

    const bound = await tx.computer.updateMany({
      where: {
        id: input.computerId,
        controlLeaseId: input.controlLeaseId,
        controlBotId: input.botId,
      },
      data: { controlRunId: executionLease.runId },
    });
    if (bound.count !== 1 || !input.threadId) return;

    await deps.events.append({
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: input.botId,
      type: "computer.takeover.granted",
      payload: { leaseId: input.controlLeaseId, takeoverRequested: true },
    });
  });
}

export async function computerScreenContext(
  prisma: PrismaClient,
  actor: Actor,
  computerId: string,
  botId: string,
  operationId: string,
): Promise<AdapterContext> {
  const context = computerContext(actor, botId, operationId);
  const lease = await prisma.computerExecutionLease.findUnique({
    where: { computerId_botId: { computerId, botId } },
    select: { runId: true, fence: true, expiresAt: true },
  });
  if (!lease || lease.expiresAt.getTime() <= Date.now()) return context;
  return { ...context, screenLeaseId: screenLeaseIdForRun(lease, lease.runId) };
}

/**
 * The provider killed this sandbox (idle timeout) while the row still says running. Clear the
 * dead ref so the UI offers a boot instead of 500ing, and rethrow anything else. Leave any
 * active control lease alone: expireComputerControl owns that release (provider screen-control,
 * events, takeover continuation).
 */
export async function clearGoneSandbox(
  deps: RouterDeps,
  computer: { id: string; providerRef: string | null; runningSince?: Date | null },
  error: unknown,
): Promise<null> {
  if (!isSandboxGoneError(error)) throw error;
  getLogger().warn(`computer ${computer.id} sandbox ${computer.providerRef} is gone`, { error });
  const cleared = await deps.prisma.computer.updateMany({
    where: { id: computer.id, providerRef: computer.providerRef },
    data: { state: "stopped", providerRef: null },
  });
  if (cleared.count === 1) await recordComputerRunEnd(deps.prisma, computer, "gone");
  return null;
}

export async function keepComputerAwake(deps: RouterDeps, computerId: string) {
  await deps.prisma.computer.updateMany({
    where: { id: computerId, state: "running" },
    data: { updatedAt: new Date() },
  });
  scheduleComputerSleep(deps.jobs, computerId);
}

export function withViewOnly(url: string, viewOnly: boolean) {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("view_only", viewOnly ? "true" : "false");
    return parsed.toString();
  } catch {
    const join = url.includes("?") ? "&" : "?";
    return `${url}${join}view_only=${viewOnly ? "true" : "false"}`;
  }
}
