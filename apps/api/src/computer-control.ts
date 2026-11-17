import { randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/server";
import type { AdapterContext } from "@rakazo/adapter-kit";
import type { ComputerExecutionLease } from "@rakazo/adapters";
import {
  acquireComputerExecutionLease,
  anotherPersonHoldsControl,
  BrowserStoppedReleaseError,
  ComputerBusyError,
  clearInactiveUserComputerControl,
  controlLeaseExpiresAt,
  enqueueTakeoverContinuation,
  expireComputerControl,
  hasActiveComputerControl,
  holdsUserControl,
  isSandboxGoneError,
  releaseComputerControlLease,
  releaseComputerExecutionLease,
  replaceComputer,
  sandboxKindCapabilities,
  scheduleComputerControlExpiry,
  scheduleComputerSleep,
  screenLeaseIdForRun,
  toComputerRef,
} from "@rakazo/adapters";
import type { Actor, ComputerStatus } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES, ClientError, computerUsingRuns } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { createRepos, IsolationError, recordComputerRunEnd, spaceIsShared } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { resolveComputerWork, toComputerStatus } from "./computer-status.js";
import type { RouterDeps } from "./router.js";
import { computerContext } from "./routes/shared.js";

/** What changing who controls a screen needs. */
type ControlDeps = Pick<RouterDeps, "prisma" | "events" | "jobs" | "sandbox">;

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
  const [work, shared] = await Promise.all([
    resolveComputerWork(deps.prisma, {
      computerId: bot.computer?.id,
      botId,
      botName: bot.name,
    }),
    spaceIsShared(deps.prisma, actor.spaceId),
  ]);
  return toComputerStatus(botId, bot.computer, work, shared, actor.userId);
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

/** Hand back this person's control of the bot's screen. Resolves true when it ended a lease. */
export async function releaseComputerControl(
  deps: ControlDeps,
  actor: Actor,
  computer: NonNullable<Awaited<ReturnType<ReturnType<typeof createRepos>["getBot"]>>["computer"]>,
  botId: string,
  reason: "released" | "done" | "skipped" = "released",
  expectedLeaseId?: string,
): Promise<boolean> {
  const leaseId = computer.controlLeaseId;
  if (computer.controlHolder !== "user" || !leaseId || computer.controlBotId !== botId) {
    return false;
  }
  if (expectedLeaseId !== undefined && expectedLeaseId !== leaseId) return false;
  if (!holdsUserControl(computer, actor.userId)) return false;
  const released = await releaseComputerControlLease(
    deps,
    computer,
    botId,
    leaseId,
    computerContext(actor, botId, "screen.release"),
    reason,
  );
  if (released) scheduleComputerSleep(deps.jobs, computer.id);
  return released;
}

/**
 * Answer a bot's request for help on its screen (Done or Skip), ending this person's control
 * first. Only the person it asked answers. Resolves the answered run.
 */
export async function answerComputerRequest(
  deps: RouterDeps,
  actor: Actor,
  botId: string,
  reason: "done" | "skipped",
  runId?: string,
): Promise<string | null> {
  // Only an answer this person may give ends control; any other reply, or a refused one, leaves
  // it alone.
  const waiting = await waitingTakeoverRun(deps, actor.spaceId, botId, runId);
  if (!waiting) return null;
  // Anyone in the Space can take the screen, so holding it never answers for someone else.
  if (waiting.userId !== actor.userId) {
    throw new ORPCError("CONFLICT", { message: "The bot is waiting for someone else" });
  }
  // Hand back before answering, so a failed hand back leaves the request for a retry.
  const bot = await createRepos(deps.prisma).getBot(actor, botId);
  if (bot.computer) await releaseComputerControl(deps, actor, bot.computer, botId, reason);
  const answered = await deps.events.answerTakeoverRequest({
    spaceId: actor.spaceId,
    botId,
    runId: waiting.id,
    reason,
  });
  if (!answered) return null;
  await enqueueTakeoverContinuation(deps.jobs, waiting.id);
  return waiting.id;
}

/** Keep this lease while its page checks in. Resolves whether it was still live to keep. */
export async function renewComputerControl(
  deps: ControlDeps,
  computerId: string,
  leaseId: string,
  expiresAt: Date,
): Promise<boolean> {
  const renewed = await deps.prisma.computer.updateMany({
    where: {
      id: computerId,
      controlHolder: "user",
      controlLeaseId: leaseId,
      // A lapsed lease is being revoked; only a live one is renewed.
      controlLeaseExpiresAt: { gt: new Date() },
    },
    data: { controlLeaseExpiresAt: expiresAt },
  });
  return renewed.count === 1;
}

/** The run of this bot that asked a person for help on its screen and still waits. */
export async function waitingTakeoverRun(
  deps: RouterDeps,
  spaceId: string,
  botId: string,
  runId?: string,
) {
  return deps.prisma.run.findFirst({
    where: { spaceId, botId, status: "waiting_takeover", ...(runId ? { id: runId } : {}) },
    orderBy: { createdAt: "desc" },
    select: { id: true, userId: true },
  });
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
  if (mode === "update" && !sandboxKindCapabilities(bot.computer.kind).inPlaceUpdate) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Computer update is not available on this device",
    });
  }
  const manualRunId = `${mode}:${randomUUID()}`;
  const lease = await acquireComputerExecutionLease(deps.prisma, {
    computerId: bot.computer.id,
    runId: manualRunId,
    botId: bot.id,
  });
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
  } finally {
    await releaseComputerExecutionLease(deps.prisma, lease);
  }
  return computerStatus(deps, context.actor, botId);
}

/** Prefix of the execution lease a screen restart holds, so takeover and Stop can tell it apart. */
export const SCREEN_RESTART_RUN_PREFIX = "screen:";

/** Matches a live restart lease on this bot, which nothing may take the screen or stop the computer under. */
export function holdingScreenRestart(botId: string, now: Date) {
  return {
    executionLeases: {
      none: { botId, runId: { startsWith: SCREEN_RESTART_RUN_PREFIX }, expiresAt: { gt: now } },
    },
  };
}

/**
 * Whether a screen is running to restart. A computer that is stopped, in error or without a
 * sandbox has none, so there is nothing to do, and the next boot starts a fresh one. A booting or suspending computer is reported as booting or running while it changes,
 * so it is refused here instead of answering as though the restart had happened.
 */
function screenRunningOrRefuse(computer: { state: string; providerRef: string | null }): boolean {
  if (computer.state === "booting" || computer.state === "suspending") {
    throw new ClientError("CONFLICT", "The computer is starting or going to sleep. Try again soon");
  }
  return computer.state === "running" && Boolean(computer.providerRef);
}

/**
 * Stop one Team bot's browser and screen without touching the shared computer or the other bots'
 * screens. Its Chrome profile stays on disk, so the screen comes back signed in on the next read.
 * Refused while the bot is working, or waiting on someone at its screen, so no run loses its page.
 */
export async function restartBotScreen(
  deps: RouterDeps,
  context: { actor: Actor },
  botId: string,
): Promise<ComputerStatus> {
  const repos = createRepos(deps.prisma);
  const bot = await repos.getBot(context.actor, botId);
  const computer = bot.computer;
  if (!computer) throw new IsolationError();
  if (computer.scope !== "team") {
    throw new ClientError("BAD_REQUEST", "Only a Team computer has a screen of its own to restart");
  }
  assertNotAnotherPersonsControl(computer, context.actor);
  if (!screenRunningOrRefuse(computer)) return computerStatus(deps, context.actor, botId);
  const releaseScreen = deps.sandbox.releaseScreen?.bind(deps.sandbox);
  if (sandboxKindCapabilities(computer.kind).restartScreen !== true || !releaseScreen) {
    throw new ClientError("BAD_REQUEST", "Restarting the screen is not available on this computer");
  }
  const refuseWhileWorking = async () => {
    const working = await deps.prisma.run.findFirst({
      where: { botId: bot.id, status: { in: [...ACTIVE_RUN_STATUSES] }, ...computerUsingRuns() },
      select: { id: true },
    });
    if (working) {
      throw new ClientError("CONFLICT", "This bot is working or waiting. Stop it, then try again");
    }
  };
  await refuseWhileWorking();

  const manualRunId = `${SCREEN_RESTART_RUN_PREFIX}${randomUUID()}`;
  // Held while the screen goes down, so a run of this bot cannot claim it half way.
  // The run the person just stopped may still hold its lease for a moment; wait that out.
  const lease = await acquireBootLease(deps.prisma, {
    computerId: computer.id,
    runId: manualRunId,
    botId: bot.id,
  });
  try {
    // Checked again under the lease: a run that began or paused for input after the first check
    // is counted now. Runs that need the computer from here on wait behind our lease.
    await refuseWhileWorking();
    // Control of this bot's screen ends first: a person's session must not outlive its browser.
    if (holdsComputerControl(computer, bot.id, context.actor)) {
      await releaseComputerControl(deps, context.actor, computer, bot.id);
    }
    // Read again now that the lease is held and our own control is gone: a Stop, a sleep or
    // someone else taking the screen since the first read must not be torn down under. From here
    // on, a takeover grant and Stop's claim both refuse while this lease is live
    // (holdingScreenRestart), so the screen cannot be taken or the computer stopped meanwhile.
    const current = (await repos.getBot(context.actor, botId)).computer;
    if (!current || current.id !== computer.id) {
      throw new ClientError("CONFLICT", "The computer changed. Try again");
    }
    assertNotAnotherPersonsControl(current, context.actor);
    // A hand back that failed leaves this person's session on the screen about to close.
    if (holdsComputerControl(current, bot.id, context.actor)) {
      throw new ClientError("CONFLICT", "Could not end your control of the screen. Try again");
    }
    if (!screenRunningOrRefuse(current)) return computerStatus(deps, context.actor, botId);
    try {
      // No lease id on purpose: the slot still names the bot's last run, and a release that
      // names another owner is refused as stale without stopping anything. The lease above is
      // what keeps a newer run from taking the screen meanwhile.
      await releaseScreen(toComputerRef(current), {
        ...computerContext(context.actor, bot.id, "screen.restart"),
        cancelRunWork: true,
      });
    } catch (error) {
      // The browser stopped and only clearing its slot failed: the next read reuses the slot.
      if (!(error instanceof BrowserStoppedReleaseError)) {
        await clearGoneSandbox(deps, current, error);
        // The sandbox was gone, so there was no screen to restart and nothing to count.
        return computerStatus(deps, context.actor, botId);
      }
    }
    // Counted once the provider answered the teardown. A refused request, or a provider that
    // reports a sandbox as gone, is not; a provider that answers success for a missing sandbox is.
    deps.analytics?.capture(context.actor.userId, {
      name: "computer_repair_started",
      action: "restartScreen",
    });
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
      await expireStaleLease(deps, computer.id, computer.controlLeaseId);
      return true;
    }
    return false;
  }
  const leaseId = computer.controlLeaseId;
  // Keep a failed revoke's lease id so reconciliation can retry provider shutdown.
  if (leaseId) {
    await expireStaleLease(deps, computer.id, leaseId);
    return true;
  }
  return clearInactiveUserComputerControl(deps.prisma, computer.id);
}

/**
 * The read that found the stale lease still answers, and every later read retries it, so a failure
 * here is a warning. The lease's expiry job reports a failure that is not a provider outage.
 */
async function expireStaleLease(deps: RouterDeps, computerId: string, leaseId: string) {
  try {
    await expireComputerControl(deps, computerId, leaseId);
  } catch (error) {
    getLogger().warn("stale computer control expiry failed", {
      "computer.id": computerId,
      "control.lease.id": leaseId,
      error,
    });
  }
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

/**
 * Give this person control of the bot's screen: one holder per computer, and a lease their page's
 * heartbeat renews.
 */
export async function takeComputerControl(
  deps: ControlDeps,
  actor: Actor,
  botId: string,
): Promise<{ leaseId: string; expiresAt: string }> {
  const repos = createRepos(deps.prisma);
  let bot = await repos.getBot(actor, botId);
  if (!bot.computer?.providerRef || bot.computer.state !== "running") {
    throw new ORPCError("BAD_REQUEST", { message: "computer must be running" });
  }
  assertNotAnotherPersonsControl(bot.computer, actor);
  if (holdsComputerControl(bot.computer, bot.id, actor)) {
    const expiresAt = controlLeaseExpiresAt();
    const leaseId = bot.computer.controlLeaseId!;
    if (await renewComputerControl(deps, bot.computer.id, leaseId, expiresAt)) {
      return { leaseId, expiresAt: expiresAt.toISOString() };
    }
    // The lease lapsed or was handed back meanwhile: take control afresh.
    bot = await repos.getBot(actor, botId);
    if (!bot.computer) throw new IsolationError();
  }
  // This person's control of another bot's screen on a shared computer ends first.
  if (hasActiveComputerControl(bot.computer) && bot.computer.controlBotId) {
    await releaseComputerControl(deps, actor, bot.computer, bot.computer.controlBotId);
  } else if (bot.computer.controlLeaseId) {
    await expireComputerControl(deps, bot.computer.id, bot.computer.controlLeaseId);
  }
  bot = await repos.getBot(actor, botId);
  if (!bot.computer?.providerRef || bot.computer.state !== "running") {
    throw new ORPCError("BAD_REQUEST", { message: "computer must be running" });
  }
  const computerId = bot.computer.id;
  const leaseId = randomUUID();
  const expiresAt = controlLeaseExpiresAt();
  // Granted at once: a bot action already running may finish, since it was based on what the
  // screen showed before this person did anything, but every action after this is refused.
  const granted = await deps.prisma.computer.updateMany({
    where: {
      id: computerId,
      state: "running",
      maintenanceId: null,
      controlHolder: { not: "user" },
      controlLeaseId: null,
      // A screen restart in progress is tearing this bot's screen down.
      ...holdingScreenRestart(bot.id, new Date()),
    },
    data: {
      controlHolder: "user",
      controlLeaseId: leaseId,
      controlLeaseExpiresAt: expiresAt,
      controlBotId: bot.id,
      controlUserId: actor.userId,
      controlFence: { increment: 1 },
    },
  });
  if (granted.count !== 1) {
    const current = await deps.prisma.computer.findUniqueOrThrow({ where: { id: computerId } });
    // A second Take control from the holder, such as a double tap, keeps their lease.
    if (holdsComputerControl(current, bot.id, actor)) {
      const renewed = controlLeaseExpiresAt();
      if (await renewComputerControl(deps, computerId, current.controlLeaseId!, renewed)) {
        return { leaseId: current.controlLeaseId!, expiresAt: renewed.toISOString() };
      }
    }
    assertNotAnotherPersonsControl(current, actor);
    throw new ORPCError("CONFLICT", { message: "Computer is busy" });
  }
  try {
    await scheduleComputerControlExpiry(deps.jobs, computerId, leaseId, expiresAt);
  } catch (error) {
    await deps.prisma.computer.updateMany({
      where: { id: computerId, controlLeaseId: leaseId },
      data: {
        controlHolder: "none",
        controlLeaseId: null,
        controlUserId: null,
        controlLeaseExpiresAt: null,
        controlBotId: null,
      },
    });
    throw error;
  }
  if (bot.thread) {
    await deps.events.append({
      spaceId: actor.spaceId,
      threadId: bot.thread.id,
      botId: bot.id,
      type: "computer.takeover.granted",
      payload: { leaseId },
    });
  }
  scheduleComputerSleep(deps.jobs, computerId);
  return { leaseId, expiresAt: expiresAt.toISOString() };
}
