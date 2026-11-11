import { randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/server";
import type { SandboxProvider } from "@rakazo/adapter-kit";
import { computerControlExpireJobKey } from "@rakazo/adapter-kit";
import type { ComputerExecutionLease } from "@rakazo/adapters";
import {
  applyTeachingDesktopInput,
  COMPUTER_SCREEN_UNAVAILABLE,
  ComputerBusyError,
  checkpointAndStopComputer,
  computerSupportsTerminal,
  computerSupportsUpdate,
  computerUpdateView,
  diskUsedPercent,
  displayBotWorkspacePath,
  ensureComputerWorkspaceLayout,
  expireComputerControl,
  hasActiveComputerControl,
  isComputerScreenUnavailable,
  isSandboxGoneError,
  provisionComputer,
  queueComputerUpdate,
  rateLimitEnds,
  releaseComputerExecutionLease,
  resolveBotUploadPath,
  resolveBotWorkspaceCwd,
  resolveBotWorkspacePath,
  scheduleComputerControlExpiry,
  scheduleComputerSleep,
  screenLeaseIdForRun,
  sleepDeferReason,
  takeoverLeaseMs,
  toComputerRef,
  touchRunningComputer,
} from "@rakazo/adapters";
import {
  attachmentMaxBytes,
  attachmentSizeLabel,
  ComputerCommandSchema,
  foldComputerCommands,
} from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES, COMPUTER_USING_RUNS, scrollDirection } from "@rakazo/core";
import { addScreenProxyCapability } from "@rakazo/core/node/screen-capability";
import type { ComputerRunEnd } from "@rakazo/db";
import {
  expireComputerExecutionLeases,
  IsolationError,
  isRecordNotFound,
  parseComputerMode,
  recordComputerRunEnd,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import {
  acquireBootLease,
  assertNotAnotherPersonsControl,
  bindWaitingTakeoverToControl,
  clearGoneSandbox,
  computerScreenContext,
  computerStatus,
  expireStaleComputerControl,
  holdsComputerControl,
  keepComputerAwake,
  releaseComputerControl,
  runComputerReplace,
  withViewOnly,
} from "../computer-control.js";
import { scrollPoint } from "../computer-input.js";
import { executionBlocksUserTakeover } from "../computer-status.js";
import type { RouterContext } from "./context.js";
import { computerContext } from "./shared.js";

/** The run paused for a person to take over this bot's computer, and who it waits on. */
async function waitingTakeoverRun(
  deps: RouterContext["deps"],
  spaceId: string,
  computerId: string,
  botId: string,
) {
  const lease = await deps.prisma.computerExecutionLease.findUnique({
    where: { computerId_botId: { computerId, botId } },
    select: { runId: true },
  });
  if (!lease) return null;
  const run = await deps.prisma.run.findUnique({
    where: { id: lease.runId, spaceId },
    select: { id: true, botId: true, status: true, userId: true },
  });
  return run?.botId === botId && run.status === "waiting_takeover" ? run : null;
}

const MAX_COMPUTER_TEXT_FILE_BYTES = 2 * 1024 * 1024;

/** Each command writes a running and a done event, so this keeps about 100 commands. */
const COMPUTER_COMMAND_HISTORY_EVENTS = 200;

export function computerRoutes(ctx: RouterContext) {
  const { deps, repos, taughtSkills, authed } = ctx;
  return {
    computer: {
      status: authed.computer.status.handler(async ({ context, input }) =>
        computerStatus(deps, context.actor, input.botId),
      ),
      boot: authed.computer.boot.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        if (!bot.computer) throw new IsolationError();
        if (bot.computer.state === "running" && bot.computer.providerRef) {
          try {
            await ensureComputerWorkspaceLayout(
              deps.sandbox,
              toComputerRef(bot.computer),
              parseComputerMode(bot.computer.scope),
              bot.id,
              computerContext(context.actor, bot.id, "boot"),
            );
            scheduleComputerSleep(deps.jobs, bot.computer.id);
            return computerStatus(deps, context.actor, input.botId);
          } catch (error) {
            await clearGoneSandbox(deps, bot.computer, error);
          }
        }
        const ctx = computerContext(context.actor, bot.id, "boot");
        const manualRunId = `boot:${randomUUID()}`;
        let lease: ComputerExecutionLease | null;
        try {
          lease = await acquireBootLease(deps.prisma, {
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
        const computerId = bot.computer.id;
        try {
          await getLogger().withContext({ reason: "manual" }, () =>
            provisionComputer(deps, computerId, {
              ...ctx,
              screenLeaseId: screenLeaseIdForRun(lease, manualRunId),
            }),
          );
          scheduleComputerSleep(deps.jobs, bot.computer.id);
        } catch (error) {
          if (error instanceof ComputerBusyError) {
            throw new ORPCError("CONFLICT", { message: "Computer is busy" });
          }
          // The bot was deleted or moved to another computer while this boot waited.
          if (isRecordNotFound(error)) {
            throw new ORPCError("NOT_FOUND", { message: "Computer no longer exists" });
          }
          throw error;
        } finally {
          await releaseComputerExecutionLease(deps.prisma, lease);
        }
        return computerStatus(deps, context.actor, input.botId);
      }),
      stop: authed.computer.stop.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        if (!bot.computer) throw new IsolationError();
        assertNotAnotherPersonsControl(bot.computer, context.actor);
        // A repeated Stop must not turn an unsafe guest back into an auto-startable one.
        if (bot.computer.state === "quarantined") {
          if (bot.computer.providerRef)
            await deps.sandbox.stop(
              toComputerRef(bot.computer),
              computerContext(context.actor, bot.id, "stop"),
            );
          return computerStatus(deps, context.actor, input.botId);
        }
        const controlLeaseId = bot.computer.controlLeaseId;
        const now = new Date();
        const claimed = await deps.prisma.computer.updateMany({
          where: {
            id: bot.computer.id,
            // Provision may resume the sandbox after Stop returns; let the boot finish first. Stop
            // acts on the state it read, so one that changed since is busy too.
            state: { equals: bot.computer.state, notIn: ["booting", "suspending", "quarantined"] },
            providerRef: bot.computer.providerRef,
            kind: bot.computer.kind,
            maintenanceId: null,
            executionLeases: {
              none: { botId: { not: bot.id }, expiresAt: { gt: now } },
            },
          },
          data: { state: "suspending" },
        });
        if (claimed.count !== 1) {
          throw new ORPCError("CONFLICT", {
            message: "Computer is busy",
          });
        }
        const otherRun = await deps.prisma.run.findFirst({
          where: {
            botId: { not: bot.id },
            status: { in: [...ACTIVE_RUN_STATUSES] },
            bot: { computerId: bot.computer.id },
            ...COMPUTER_USING_RUNS,
          },
          select: { id: true },
        });
        if (otherRun) {
          await deps.prisma.computer.updateMany({
            where: { id: bot.computer.id, state: "suspending" },
            data: { state: bot.computer.state },
          });
          throw new ORPCError("CONFLICT", {
            message: "Other Team bots are still using this computer",
          });
        }
        await expireComputerExecutionLeases(deps.prisma, {
          computerId: bot.computer.id,
          botId: bot.id,
        });
        let stopping = false;
        try {
          let end: ComputerRunEnd = "stopped";
          if (bot.computer.providerRef) {
            const ctx = computerContext(context.actor, bot.id, "stop");
            const ref = toComputerRef(bot.computer);
            try {
              if (bot.computer.state === "stopped" || bot.computer.state === "suspended") {
                // It was saved when it went down and its provider keeps the disk, so a save would
                // only wake it.
                stopping = true;
                await deps.sandbox.stop(ref, ctx);
              } else {
                await checkpointAndStopComputer(deps, bot.computer, ref, ctx, () => {
                  stopping = true;
                });
              }
            } catch (error) {
              // The sandbox is already gone: nothing left to checkpoint or stop.
              if (!isSandboxGoneError(error)) throw error;
              end = "gone";
            }
          }
          const stopped = await deps.prisma.computer.updateMany({
            where: {
              id: bot.computer.id,
              state: "suspending",
              providerRef: bot.computer.providerRef,
              kind: bot.computer.kind,
            },
            data: {
              state: "stopped",
              controlHolder: "none",
              controlLeaseId: null,
              controlUserId: null,
              controlLeaseExpiresAt: null,
              controlBotId: null,
              controlRunId: null,
            },
          });
          if (stopped.count !== 1) return computerStatus(deps, context.actor, input.botId);
          await recordComputerRunEnd(deps.prisma, bot.computer, end);
        } catch (error) {
          // A failed save, or a stop the provider put off, leaves the computer up: hand it back
          // to idle sleep and metering instead of hiding it as an error.
          const stillUp = !stopping || sleepDeferReason(error) !== undefined;
          await deps.prisma.computer
            .updateMany({
              where: { id: bot.computer.id, state: "suspending" },
              data: { state: stillUp ? bot.computer.state : "error" },
            })
            .catch(() => undefined);
          if (stillUp)
            scheduleComputerSleep(deps.jobs, bot.computer.id, undefined, rateLimitEnds(error));
          throw error;
        }
        await deps.jobs.cancel(
          computerControlExpireJobKey(bot.computer.id, controlLeaseId ?? undefined),
        );
        return computerStatus(deps, context.actor, input.botId);
      }),
      recover: authed.computer.recover.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        if (!bot.computer) throw new IsolationError();
        assertNotAnotherPersonsControl(bot.computer, context.actor);
        if (!computerSupportsUpdate(bot.computer.kind))
          throw new ORPCError("BAD_REQUEST", {
            message: "Computer recovery is not available on this device",
          });
        try {
          return await queueComputerUpdate(deps, bot.computer.id, bot.id, "recover");
        } catch (error) {
          if (error instanceof ComputerBusyError)
            throw new ORPCError("CONFLICT", { message: "Computer is busy" });
          throw error;
        }
      }),
      reset: authed.computer.reset.handler(async ({ context, input }) =>
        runComputerReplace(deps, context, input.botId, "reset", "reset"),
      ),
      update: authed.computer.update.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        if (!bot.computer) throw new IsolationError();
        assertNotAnotherPersonsControl(bot.computer, context.actor);
        if (!computerSupportsUpdate(bot.computer.kind))
          throw new ORPCError("BAD_REQUEST", {
            message: "Computer update is not available on this device",
          });
        try {
          return await queueComputerUpdate(deps, bot.computer.id, bot.id);
        } catch (error) {
          if (error instanceof ComputerBusyError)
            throw new ORPCError("CONFLICT", { message: "Computer is busy" });
          throw error;
        }
      }),
      updates: authed.computer.updates.handler(async ({ context }) => {
        const rows = await deps.prisma.computerUpdate.findMany({
          where: {
            status: { in: ["queued", "running", "interrupted", "failed"] },
            computer: {
              spaceId: context.actor.spaceId,
              bots: { some: { archivedAt: null } },
            },
          },
          include: {
            computer: {
              include: {
                bots: {
                  where: { archivedAt: null },
                  select: { id: true, name: true },
                },
              },
            },
          },
          orderBy: { createdAt: "desc" },
        });
        return rows.map((row) => computerUpdateView(row));
      }),
      releaseInterrupted: authed.computer.releaseInterrupted.handler(() => {
        throw new ORPCError("FORBIDDEN");
      }),
      dismissUpdate: authed.computer.dismissUpdate.handler(async ({ context, input }) => {
        await deps.prisma.computerUpdate.updateMany({
          where: {
            id: input.id,
            status: "failed",
            computer: {
              spaceId: context.actor.spaceId,
              bots: { some: { archivedAt: null } },
            },
          },
          data: { status: "dismissed" },
        });
        return { ok: true as const };
      }),
      dismissDiskWarning: authed.computer.dismissDiskWarning.handler(async ({ context, input }) => {
        const computer = (await repos.getBot(context.actor, input.botId)).computer;
        const percent = computer ? diskUsedPercent(computer) : null;
        if (computer && percent !== null) {
          await deps.prisma.computer.updateMany({
            where: { id: computer.id },
            data: { diskDismissedPercent: percent },
          });
        }
        return { ok: true as const };
      }),
      takeover: authed.computer.takeover.handler(async ({ context, input }) => {
        let bot = await repos.getBot(context.actor, input.botId);
        if (!bot.computer?.providerRef || bot.computer.state !== "running") {
          throw new ORPCError("BAD_REQUEST", { message: "computer must be running" });
        }
        assertNotAnotherPersonsControl(bot.computer, context.actor);
        if (hasActiveComputerControl(bot.computer) && bot.computer.controlBotId === bot.id) {
          await bindWaitingTakeoverToControl(deps, {
            spaceId: context.actor.spaceId,
            threadId: bot.thread?.id,
            botId: bot.id,
            computerId: bot.computer.id,
            controlLeaseId: bot.computer.controlLeaseId!,
            controlRunId: bot.computer.controlRunId,
          });
          await scheduleComputerControlExpiry(
            deps.jobs,
            bot.computer.id,
            bot.computer.controlLeaseId!,
            bot.computer.controlLeaseExpiresAt!,
          );
          return {
            leaseId: bot.computer.controlLeaseId!,
            expiresAt: bot.computer.controlLeaseExpiresAt!.toISOString(),
          };
        }
        if (hasActiveComputerControl(bot.computer) && bot.computer.controlBotId !== bot.id) {
          await releaseComputerControl(deps, context.actor, bot.computer.controlBotId!, "skipped");
          bot = await repos.getBot(context.actor, input.botId);
          if (!bot.computer) throw new IsolationError();
        }
        // Read again: someone else may have taken the screen since the first check, and their
        // live lease is never expired here.
        assertNotAnotherPersonsControl(bot.computer, context.actor);
        if (bot.computer.controlLeaseId) {
          await expireComputerControl(deps, bot.computer.id, bot.computer.controlLeaseId);
          bot = await repos.getBot(context.actor, input.botId);
        }
        if (!bot.computer) throw new IsolationError();
        // Gone-sandbox revoke may have marked the row stopped; do not fall through to the
        // running-state grant and return a confusing "control changed" conflict.
        if (!bot.computer.providerRef || bot.computer.state !== "running") {
          throw new ORPCError("BAD_REQUEST", { message: "computer must be running" });
        }

        const executionLease = await deps.prisma.computerExecutionLease.findUnique({
          where: { computerId_botId: { computerId: bot.computer.id, botId: bot.id } },
        });
        const executionRun = executionLease
          ? await deps.prisma.run.findUnique({
              where: { id: executionLease.runId },
              select: { botId: true, status: true, userId: true },
            })
          : null;
        const waitingForTakeover =
          executionRun?.botId === bot.id &&
          (executionRun.status === "waiting_takeover" ||
            bot.computer.controlRunId === executionLease?.runId);
        // A run that asked a person to take over waits for that person, not whoever opens the screen.
        if (waitingForTakeover && executionRun?.userId !== context.actor.userId) {
          throw new ORPCError("CONFLICT", { message: "The bot is waiting for someone else" });
        }
        if (
          executionBlocksUserTakeover({
            hasLease: Boolean(executionLease),
            leaseExpiresAt: executionLease?.expiresAt,
            runStatus: executionRun?.status,
            takeoverRequested: waitingForTakeover,
          })
        ) {
          throw new ORPCError("CONFLICT", { message: "Stop the bot first" });
        }
        // Keep an inactive lease as a fencing tombstone. The next run reclaims it
        // with a higher fence, even if this user's screen remains connected.

        const leaseId = randomUUID();
        const expiresAt = new Date(Date.now() + takeoverLeaseMs());
        const granted = await deps.prisma.computer.updateMany({
          where: {
            id: bot.computer.id,
            state: "running",
            maintenanceId: null,
            controlHolder: { not: "user" },
            controlLeaseId: null,
          },
          data: {
            controlHolder: "user",
            controlLeaseId: leaseId,
            controlLeaseExpiresAt: expiresAt,
            controlBotId: bot.id,
            controlRunId: waitingForTakeover ? executionLease?.runId : null,
            controlUserId: context.actor.userId,
            state: "running",
          },
        });
        if (granted.count !== 1) {
          const current = await deps.prisma.computer.findUniqueOrThrow({
            where: { id: bot.computer.id },
          });
          if (!hasActiveComputerControl(current) || current.controlBotId !== bot.id) {
            throw new ORPCError("CONFLICT", { message: "Computer control changed; try again" });
          }
          assertNotAnotherPersonsControl(current, context.actor);
          await bindWaitingTakeoverToControl(deps, {
            spaceId: context.actor.spaceId,
            threadId: bot.thread?.id,
            botId: bot.id,
            computerId: current.id,
            controlLeaseId: current.controlLeaseId!,
            controlRunId: current.controlRunId,
          });
          await scheduleComputerControlExpiry(
            deps.jobs,
            current.id,
            current.controlLeaseId!,
            current.controlLeaseExpiresAt!,
          );
          return {
            leaseId: current.controlLeaseId!,
            expiresAt: current.controlLeaseExpiresAt!.toISOString(),
          };
        }
        const computerId = bot.computer.id;
        const withdrawGrant = () =>
          deps.prisma.computer.updateMany({
            where: { id: computerId, controlLeaseId: leaseId },
            data: {
              controlHolder: "none",
              controlLeaseId: null,
              controlUserId: null,
              controlLeaseExpiresAt: null,
              controlBotId: null,
              controlRunId: null,
            },
          });
        if (waitingForTakeover && executionLease) {
          // The wait can end (expired, or yielded to newer work) between the read above and the
          // grant. Bound to an ended run, the user would share the screen with the next run.
          const waiting = await deps.prisma.run.findUnique({
            where: { id: executionLease.runId },
            select: { status: true },
          });
          if (!ACTIVE_RUN_STATUSES.some((status) => status === waiting?.status)) {
            await withdrawGrant();
            throw new ORPCError("CONFLICT", { message: "Computer control changed; try again" });
          }
        }
        try {
          await scheduleComputerControlExpiry(deps.jobs, computerId, leaseId, expiresAt);
        } catch (error) {
          await withdrawGrant();
          throw error;
        }
        if (bot.thread) {
          await deps.events.append({
            spaceId: context.actor.spaceId,
            threadId: bot.thread.id,
            botId: bot.id,
            type: "computer.takeover.granted",
            payload: { leaseId, takeoverRequested: waitingForTakeover },
          });
        }
        scheduleComputerSleep(deps.jobs, bot.computer.id);
        return { leaseId, expiresAt: expiresAt.toISOString() };
      }),
      release: authed.computer.release.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        if (bot.computer) assertNotAnotherPersonsControl(bot.computer, context.actor);
        // A needs-you card answers its own run, before or after the person opens the screen.
        if (input.runId) {
          const waiting = bot.computer
            ? await waitingTakeoverRun(deps, context.actor.spaceId, bot.computer.id, bot.id)
            : null;
          if (waiting?.id !== input.runId) {
            throw new ORPCError("CONFLICT", { message: "The bot is no longer waiting" });
          }
          // The person it asked, or whoever already holds the screen bound to this run.
          const drivesThisRun =
            bot.computer?.controlHolder === "user" &&
            bot.computer.controlUserId === context.actor.userId &&
            bot.computer.controlRunId === waiting.id;
          if (waiting.userId !== context.actor.userId && !drivesThisRun) {
            throw new ORPCError("CONFLICT", { message: "The bot is waiting for someone else" });
          }
        }
        await releaseComputerControl(deps, context.actor, input.botId, input.reason, input.runId);
        if (input.runId) {
          // The card waits for its answer to land, so one that changed nothing must say so.
          const after = await deps.prisma.run.findUnique({
            where: { id: input.runId, spaceId: context.actor.spaceId },
            select: { status: true },
          });
          if (after?.status === "waiting_takeover") {
            throw new ORPCError("CONFLICT", { message: "Could not continue" });
          }
        }
        return { ok: true as const };
      }),
      input: authed.computer.input.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        const computer = bot.computer;
        if (!computer || !holdsComputerControl(computer, bot.id, context.actor)) {
          await expireStaleComputerControl(deps, computer);
          throw new ORPCError("FORBIDDEN");
        }
        if (!computer.providerRef) return { ok: true as const };
        const sensitive = input.payload.sensitive === true;
        const skillId =
          sensitive && typeof input.payload.skillId === "string" && input.payload.skillId
            ? input.payload.skillId
            : undefined;
        const mapped = {
          ...(input.kind === "key"
            ? { kind: "key" as const, key: String(input.payload.key ?? ""), sensitive }
            : input.kind === "clipboard"
              ? {
                  kind: "clipboard" as const,
                  text: String(input.payload.text ?? ""),
                  sensitive,
                }
              : input.kind === "scroll"
                ? {
                    kind: "scroll" as const,
                    direction: scrollDirection(input.payload.direction),
                    amount: Number(input.payload.amount ?? 3),
                    ...scrollPoint(input.payload),
                    sensitive,
                  }
                : {
                    kind: "pointer" as const,
                    x: Number(input.payload.x ?? 0),
                    y: Number(input.payload.y ?? 0),
                    button: (input.payload.button as "left" | "right" | undefined) ?? "left",
                    type:
                      (input.payload.type as "move" | "down" | "up" | "click" | undefined) ??
                      "click",
                    sensitive,
                  }),
          ...(skillId ? { skillId } : {}),
        };
        const outcome = await taughtSkills.recordInput(context.actor, bot.id, mapped);
        if (outcome === "stale") return { ok: true as const };
        if (outcome !== "recorded") {
          await applyTeachingDesktopInput(
            deps.sandbox,
            computer,
            mapped,
            computerContext(context.actor, bot.id, "input"),
          );
        }
        await deps.prisma.computer.updateMany({
          where: { id: computer.id, state: "running" },
          data: { updatedAt: new Date() },
        });
        scheduleComputerSleep(deps.jobs, computer.id);
        return { ok: true as const };
      }),
      files: authed.computer.files.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        if (!bot.computer) throw new IsolationError();
        const computer = bot.computer;
        const computerMode = parseComputerMode(computer.scope);
        const ctx = computerContext(context.actor, bot.id, "files");
        const storedPath = resolveBotWorkspacePath(computerMode, bot.id, input.path);
        let entries: Awaited<ReturnType<SandboxProvider["listFiles"]>>;
        if (computer.state === "running" && computer.providerRef) {
          await deps.prisma.computer.updateMany({
            where: { id: computer.id, state: "running" },
            data: { updatedAt: new Date() },
          });
          scheduleComputerSleep(deps.jobs, computer.id);
          const ref = toComputerRef(computer);
          await ensureComputerWorkspaceLayout(deps.sandbox, ref, computerMode, bot.id, ctx);
          entries = await deps.sandbox.listFiles(ref, storedPath, ctx);
        } else {
          entries = await deps.home.list(computer.homeKey, storedPath, ctx);
        }
        return entries.map((entry) => ({
          ...entry,
          path: displayBotWorkspacePath(computerMode, bot.id, input.path, entry.path),
        }));
      }),
      readFile: authed.computer.readFile.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        if (!bot.computer) throw new IsolationError();
        const computerMode = parseComputerMode(bot.computer.scope);
        const ctx = computerContext(context.actor, bot.id, "read");
        const storedPath = resolveBotWorkspacePath(computerMode, bot.id, input.path);
        let content: string;
        if (bot.computer.state === "running" && bot.computer.providerRef) {
          await deps.prisma.computer.updateMany({
            where: { id: bot.computer.id, state: "running" },
            data: { updatedAt: new Date() },
          });
          scheduleComputerSleep(deps.jobs, bot.computer.id);
          const bytes = await deps.sandbox
            .readFile(toComputerRef(bot.computer), storedPath, ctx, {
              maxBytes: MAX_COMPUTER_TEXT_FILE_BYTES,
            })
            .catch((error: unknown) => {
              if (error instanceof Error && /exceeds|too large/i.test(error.message)) {
                throw new ORPCError("BAD_REQUEST", { message: "file is too large to preview" });
              }
              throw error;
            });
          try {
            content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          } catch {
            throw new ORPCError("BAD_REQUEST", { message: "file is not a text file" });
          }
        } else {
          try {
            content = await deps.home.readFile(bot.computer.homeKey, storedPath, ctx, {
              maxBytes: MAX_COMPUTER_TEXT_FILE_BYTES,
            });
          } catch (error) {
            if (error instanceof Error && error.message.startsWith("agent home file exceeds ")) {
              throw new ORPCError("BAD_REQUEST", { message: "file is too large to preview" });
            }
            // The file browser can ask for a file deleted since it last listed.
            if (error instanceof Error && "code" in error && error.code === "ENOENT") {
              throw new ORPCError("NOT_FOUND", { message: "file not found" });
            }
            throw error;
          }
        }
        return { path: input.path, content };
      }),
      downloadFile: authed.computer.downloadFile.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        const computer = bot.computer;
        if (!computer) throw new IsolationError();
        // The stopped-computer home store is text-only; binary transfer needs the live machine.
        if (computer.state !== "running" || !computer.providerRef) {
          throw new ORPCError("CONFLICT", { message: "Start the computer first." });
        }
        await keepComputerAwake(deps, computer.id);
        const storedPath = resolveBotWorkspacePath(
          parseComputerMode(computer.scope),
          bot.id,
          input.path,
        );
        const bytes = await deps.sandbox
          .readFile(
            toComputerRef(computer),
            storedPath,
            computerContext(context.actor, bot.id, "download"),
            { maxBytes: attachmentMaxBytes(deps.env) },
          )
          .catch((error: unknown) => {
            if (error instanceof Error && /exceeds|too large/i.test(error.message)) {
              throw new ORPCError("BAD_REQUEST", {
                message: `File exceeds the ${attachmentSizeLabel(attachmentMaxBytes(deps.env))} download limit.`,
              });
            }
            throw error;
          });
        return { path: input.path, contentBase64: Buffer.from(bytes).toString("base64") };
      }),
      uploadFile: authed.computer.uploadFile.handler(async ({ context, input }) => {
        let bot = await repos.getBot(context.actor, input.botId);
        if (await expireStaleComputerControl(deps, bot.computer)) {
          bot = await repos.getBot(context.actor, input.botId);
        }
        const computer = bot.computer;
        if (!computer) throw new IsolationError();
        if (computer.state !== "running" || !computer.providerRef) {
          throw new ORPCError("CONFLICT", { message: "Start the computer first." });
        }
        if (!holdsComputerControl(computer, bot.id, context.actor)) {
          throw new ORPCError("FORBIDDEN", { message: "Take control first." });
        }
        const maxBytes = attachmentMaxBytes(deps.env);
        if (input.contentBase64.length > Math.ceil(maxBytes / 3) * 4) {
          throw new ORPCError("BAD_REQUEST", {
            message: `File exceeds the ${attachmentSizeLabel(maxBytes)} upload limit.`,
          });
        }
        const content = Buffer.from(input.contentBase64, "base64");
        if (content.byteLength > maxBytes) {
          throw new ORPCError("BAD_REQUEST", {
            message: `File exceeds the ${attachmentSizeLabel(maxBytes)} upload limit.`,
          });
        }
        await keepComputerAwake(deps, computer.id);
        let storedPath: string;
        try {
          storedPath = resolveBotUploadPath(parseComputerMode(computer.scope), bot.id, input.path);
        } catch (error) {
          if (error instanceof Error && /escapes/i.test(error.message)) {
            throw new ORPCError("BAD_REQUEST", { message: error.message });
          }
          throw error;
        }
        await deps.sandbox.writeFile(
          toComputerRef(computer),
          { path: storedPath, content },
          computerContext(context.actor, bot.id, "upload"),
        );
        return { ok: true as const };
      }),
      commands: authed.computer.commands.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        const events = await deps.prisma.event.findMany({
          where: { spaceId: context.actor.spaceId, botId: bot.id, type: "computer.command" },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: COMPUTER_COMMAND_HISTORY_EVENTS,
          select: { payload: true, createdAt: true },
        });
        return foldComputerCommands(
          events.reverse().flatMap((event) => {
            const parsed = ComputerCommandSchema.safeParse(event.payload);
            return parsed.success
              ? [{ ...parsed.data, createdAt: event.createdAt.toISOString() }]
              : [];
          }),
        );
      }),
      terminalUrl: authed.computer.terminalUrl.handler(async ({ context, input }) => {
        let bot = await repos.getBot(context.actor, input.botId);
        if (await expireStaleComputerControl(deps, bot.computer)) {
          bot = await repos.getBot(context.actor, input.botId);
        }
        const computer = bot.computer;
        if (
          !computer?.providerRef ||
          computer.state !== "running" ||
          !deps.sandbox.connectTerminal ||
          !computerSupportsTerminal(computer.kind)
        ) {
          return { url: null };
        }
        // Same rule as the interactive screen: only the user holding this bot's control lease.
        if (!holdsComputerControl(computer, bot.id, context.actor) || !computer.controlLeaseId) {
          throw new ORPCError("FORBIDDEN", { message: "Take control first." });
        }
        const session = await deps.sandbox
          .connectTerminal(
            toComputerRef(computer),
            {
              controlToken: computer.controlLeaseId,
              cwd: resolveBotWorkspaceCwd(parseComputerMode(computer.scope), bot.id, undefined),
            },
            await computerScreenContext(
              deps.prisma,
              context.actor,
              computer.id,
              bot.id,
              "terminal",
            ),
          )
          .catch((error: unknown) => clearGoneSandbox(deps, computer, error));
        if (!session) return { url: null };
        await keepComputerAwake(deps, computer.id);
        return {
          url: addScreenProxyCapability(
            withViewOnly(session.url, false),
            deps.env.screenProxySecret,
            deps.env.webOrigin,
            {
              botId: bot.id,
              computerId: computer.id,
              botGeneration: bot.screenGeneration,
              computerGeneration: computer.screenGeneration,
              controlLeaseId: computer.controlLeaseId,
            },
            undefined,
            session.headers,
          ),
        };
      }),
      screenUrl: authed.computer.screenUrl.handler(async ({ context, input }) => {
        let bot = await repos.getBot(context.actor, input.botId);
        if (await expireStaleComputerControl(deps, bot.computer)) {
          bot = await repos.getBot(context.actor, input.botId);
        }
        if (
          !bot.computer?.providerRef ||
          (bot.computer.state !== "running" && bot.computer.state !== "booting")
        ) {
          return { url: null };
        }
        const computer = bot.computer;
        // Everyone in the Space can watch; only the person holding control can drive it.
        const holder = holdsComputerControl(computer, bot.id, context.actor);
        const session = await deps.sandbox
          .connectScreen(
            toComputerRef(computer),
            {
              view: "stream",
              interactive: holder,
              controlToken: holder ? (computer.controlLeaseId ?? undefined) : undefined,
            },
            await computerScreenContext(deps.prisma, context.actor, computer.id, bot.id, "screen"),
          )
          .catch(async (error: unknown) => {
            if (isComputerScreenUnavailable(error)) {
              throw new ORPCError("CONFLICT", { message: COMPUTER_SCREEN_UNAVAILABLE });
            }
            return clearGoneSandbox(deps, computer, error);
          });
        if (!session?.url) return { url: null };
        scheduleComputerSleep(deps.jobs, bot.computer.id);
        const viewUrl = withViewOnly(session.url, !holder);
        return {
          url: addScreenProxyCapability(
            viewUrl,
            deps.env.screenProxySecret,
            deps.env.webOrigin,
            {
              botId: bot.id,
              computerId: computer.id,
              botGeneration: bot.screenGeneration,
              computerGeneration: computer.screenGeneration,
              controlLeaseId: computer.controlLeaseId,
            },
            undefined,
            session.headers,
          ),
        };
      }),
      preview: authed.computer.preview.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        const computer = bot.computer;
        if (!computer?.providerRef || computer.state !== "running") return { image: null };
        if (input.runId) {
          const waiting = await waitingTakeoverRun(
            deps,
            context.actor.spaceId,
            computer.id,
            bot.id,
          );
          if (waiting?.id !== input.runId) return { image: null };
        }
        const observation = await deps.sandbox
          .observe(
            toComputerRef(computer),
            await computerScreenContext(deps.prisma, context.actor, computer.id, bot.id, "screen"),
          )
          .catch(async (error: unknown) => {
            if (isSandboxGoneError(error)) return clearGoneSandbox(deps, computer, error);
            getLogger().warn("computer.preview_failed", { error });
            return null;
          });
        if (!observation) return { image: null };
        const data = Buffer.from(observation.image).toString("base64");
        return { image: `data:${observation.mimeType};base64,${data}` };
      }),
      heartbeat: authed.computer.heartbeat.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        if (bot.computer?.state === "running" && bot.computer.providerRef) {
          await deps.prisma.computer.updateMany({
            where: { id: bot.computer.id, state: "running" },
            data: { updatedAt: new Date() },
          });
          await touchRunningComputer(
            { sandbox: deps.sandbox, jobs: deps.jobs },
            {
              id: bot.computer.id,
              homeKey: bot.computer.homeKey,
              providerRef: bot.computer.providerRef,
              kind: bot.computer.kind,
              runningSince: bot.computer.runningSince,
              controlHolder: bot.computer.controlHolder,
              controlLeaseId: bot.computer.controlLeaseId,
              controlLeaseExpiresAt: bot.computer.controlLeaseExpiresAt,
            },
          ).catch(() => undefined);
        }
        return { ok: true as const };
      }),
    },
  };
}
