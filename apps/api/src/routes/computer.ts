import { randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/server";
import type { AdapterContext, SandboxProvider } from "@rakazo/adapter-kit";
import { computerControlExpireJobKey } from "@rakazo/adapter-kit";
import type { ComputerExecutionLease } from "@rakazo/adapters";
import {
  acquireComputerExecutionLease,
  applyTeachingDesktopInput,
  COMPUTER_SCREEN_UNAVAILABLE,
  ComputerBusyError,
  checkpointAndStopComputer,
  clearInactiveUserComputerControl,
  computerSupportsTerminal,
  computerSupportsUpdate,
  computerUpdateView,
  displayBotWorkspacePath,
  enqueueTakeoverContinuation,
  ensureComputerWorkspaceLayout,
  expireComputerControl,
  hasActiveComputerControl,
  isComputerScreenUnavailable,
  isSandboxGoneError,
  provisionComputer,
  queueComputerUpdate,
  releaseComputerExecutionLease,
  replaceComputer,
  resolveBotUploadPath,
  resolveBotWorkspaceCwd,
  resolveBotWorkspacePath,
  revokeScreenControl,
  scheduleComputerControlExpiry,
  scheduleComputerSleep,
  screenLeaseIdForRun,
  takeoverLeaseMs,
  toComputerRef,
  touchRunningComputer,
} from "@rakazo/adapters";
import type { Actor, ComputerReleaseReason, ComputerStatus } from "@rakazo/contracts";
import {
  attachmentMaxBytes,
  attachmentSizeLabel,
  ComputerCommandSchema,
  foldComputerCommands,
} from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES, scrollDirection } from "@rakazo/core";
import { addScreenProxyCapability } from "@rakazo/core/node/screen-capability";
import type { ComputerRunEnd, PrismaClient } from "@rakazo/db";
import {
  createRepos,
  expireComputerExecutionLeases,
  IsolationError,
  parseComputerMode,
  recordComputerRunEnd,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { scrollPoint } from "../computer-input.js";
import {
  executionBlocksUserTakeover,
  resolveBusyBotName,
  toComputerStatus,
} from "../computer-status.js";
import type { RouterDeps } from "../router.js";
import type { RouterContext } from "./context.js";
import { computerContext, isRecordNotFound } from "./shared.js";

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
            // Provision may resume the sandbox after Stop returns; let the boot finish first.
            state: { notIn: ["booting", "suspending", "quarantined"] },
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
        try {
          let end: ComputerRunEnd = "stopped";
          if (bot.computer.providerRef) {
            const ctx = computerContext(context.actor, bot.id, "stop");
            const ref = toComputerRef(bot.computer);
            try {
              await checkpointAndStopComputer(deps, bot.computer, ref, ctx);
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
              controlLeaseExpiresAt: null,
              controlBotId: null,
              controlRunId: null,
            },
          });
          if (stopped.count !== 1) return computerStatus(deps, context.actor, input.botId);
          await recordComputerRunEnd(deps.prisma, bot.computer, end);
        } catch (error) {
          await deps.prisma.computer
            .updateMany({
              where: { id: bot.computer.id, state: "suspending" },
              data: { state: "error" },
            })
            .catch(() => undefined);
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
              bots: { some: { userId: context.actor.userId, archivedAt: null } },
            },
          },
          include: {
            computer: {
              include: {
                bots: {
                  where: { userId: context.actor.userId, archivedAt: null },
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
              bots: { some: { userId: context.actor.userId, archivedAt: null } },
            },
          },
          data: { status: "dismissed" },
        });
        return { ok: true as const };
      }),
      takeover: authed.computer.takeover.handler(async ({ context, input }) => {
        let bot = await repos.getBot(context.actor, input.botId);
        if (!bot.computer?.providerRef || bot.computer.state !== "running") {
          throw new ORPCError("BAD_REQUEST", { message: "computer must be running" });
        }
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
          const previousBotId = bot.computer.controlBotId!;
          await revokeScreenControl(
            deps,
            bot.computer,
            computerContext(context.actor, previousBotId, "screen.release"),
            bot.computer.controlLeaseId ?? undefined,
          );
          await deps.prisma.computer.updateMany({
            where: { id: bot.computer.id, controlLeaseId: bot.computer.controlLeaseId },
            data: {
              controlHolder: "none",
              controlLeaseId: null,
              controlLeaseExpiresAt: null,
              controlBotId: null,
              controlRunId: null,
            },
          });
          bot = await repos.getBot(context.actor, input.botId);
          if (!bot.computer) throw new IsolationError();
        }
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
              select: { botId: true, status: true },
            })
          : null;
        const waitingForTakeover =
          executionRun?.botId === bot.id &&
          (executionRun.status === "waiting_takeover" ||
            bot.computer.controlRunId === executionLease?.runId);
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
        await releaseComputerControl(deps, context.actor, input.botId, input.reason);
        return { ok: true as const };
      }),
      input: authed.computer.input.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        const computer = bot.computer;
        if (!computer || !hasActiveComputerControl(computer) || computer.controlBotId !== bot.id) {
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
        if (!hasActiveComputerControl(computer) || computer.controlBotId !== bot.id) {
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
        if (
          !hasActiveComputerControl(computer) ||
          computer.controlBotId !== bot.id ||
          !computer.controlLeaseId
        ) {
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
        const session = await deps.sandbox
          .connectScreen(
            toComputerRef(computer),
            {
              view: "stream",
              interactive: hasActiveComputerControl(computer) && computer.controlBotId === bot.id,
              controlToken:
                computer.controlBotId === bot.id
                  ? (computer.controlLeaseId ?? undefined)
                  : undefined,
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
        const viewUrl = withViewOnly(
          session.url,
          !(hasActiveComputerControl(bot.computer) && bot.computer.controlBotId === bot.id),
        );
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

const BOOT_LEASE_RETRY_MS = 250;
const BOOT_LEASE_ATTEMPTS = 20;

/**
 * A run lets go of its computer in its executor's finally, a moment after the run ends. A boot
 * sent as the run finishes waits that moment out instead of being refused as busy.
 */
async function acquireBootLease(
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

async function computerStatus(
  deps: RouterDeps,
  actor: Actor,
  botId: string,
): Promise<ComputerStatus> {
  const repos = createRepos(deps.prisma);
  let bot = await repos.getBot(actor, botId);
  if (await expireStaleComputerControl(deps, bot.computer)) {
    bot = await repos.getBot(actor, botId);
  }
  const busyBotName = await resolveBusyBotName(deps.prisma, {
    computerId: bot.computer?.id,
    botId,
    botName: bot.name,
  });
  return toComputerStatus(botId, bot.computer, busyBotName);
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

async function runComputerReplace(
  deps: RouterDeps,
  context: { actor: Actor },
  botId: string,
  mode: "recover" | "reset" | "update",
  operationId: string,
): Promise<ComputerStatus> {
  const repos = createRepos(deps.prisma);
  const bot = await repos.getBot(context.actor, botId);
  if (!bot.computer) throw new IsolationError();
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

async function expireStaleComputerControl(
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
async function bindWaitingTakeoverToControl(
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

async function computerScreenContext(
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
async function clearGoneSandbox(
  deps: RouterDeps,
  computer: { id: string; providerRef: string | null; runningSince?: Date | null },
  error: unknown,
): Promise<null> {
  if (!isSandboxGoneError(error)) throw error;
  getLogger().error(`computer ${computer.id} sandbox ${computer.providerRef} is gone`, error);
  const cleared = await deps.prisma.computer.updateMany({
    where: { id: computer.id, providerRef: computer.providerRef },
    data: { state: "stopped", providerRef: null },
  });
  if (cleared.count === 1) await recordComputerRunEnd(deps.prisma, computer, "gone");
  return null;
}

async function keepComputerAwake(deps: RouterDeps, computerId: string) {
  await deps.prisma.computer.updateMany({
    where: { id: computerId, state: "running" },
    data: { updatedAt: new Date() },
  });
  scheduleComputerSleep(deps.jobs, computerId);
}

function withViewOnly(url: string, viewOnly: boolean) {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("view_only", viewOnly ? "true" : "false");
    return parsed.toString();
  } catch {
    const join = url.includes("?") ? "&" : "?";
    return `${url}${join}view_only=${viewOnly ? "true" : "false"}`;
  }
}
