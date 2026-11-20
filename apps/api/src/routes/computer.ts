import { randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/server";
import type { AgentHomeStore, SandboxProvider } from "@rakazo/adapter-kit";
import { computerControlExpireJobKey, SandboxFileTooLargeError } from "@rakazo/adapter-kit";
import {
  applyTeachingDesktopInput,
  ComputerScreenUnavailableError,
  checkpointAndStopComputer,
  computerUpdateView,
  controlLeaseExpiresAt,
  diskUsedPercent,
  displayBotWorkspacePath,
  endTeachingWithLease,
  ensureComputerWorkspaceLayout,
  isSandboxGoneError,
  ObjectAgentHomeStore,
  provisionComputer,
  queueComputerUpdate,
  rateLimitEnds,
  releaseComputerExecutionLease,
  resolveBotUploadPath,
  resolveBotWorkspaceCwd,
  resolveBotWorkspacePath,
  sandboxKindCapabilities,
  scheduleComputerSleep,
  screenLeaseIdForRun,
  sleepDeferReason,
  toComputerRef,
  touchRunningComputer,
  WorkspacePathError,
  wakeableComputerRef,
} from "@rakazo/adapters";
import {
  attachmentMaxBytes,
  attachmentSizeLabel,
  ComputerCommandSchema,
  foldComputerCommands,
} from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES, ClientError, computerUsingRuns, scrollDirection } from "@rakazo/core";
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
  answerComputerRequest,
  assertNotAnotherPersonsControl,
  clearGoneSandbox,
  computerScreenContext,
  computerStatus,
  expireStaleComputerControl,
  holdsComputerControl,
  keepComputerAwake,
  releaseComputerControl,
  renewComputerControl,
  runComputerReplace,
  takeComputerControl,
  waitingTakeoverRun,
  withViewOnly,
} from "../computers/computer-control.js";
import { scrollPoint } from "../computers/computer-input.js";
import type { RouterContext } from "./context.js";
import { computerContext } from "./shared.js";

const MAX_COMPUTER_TEXT_FILE_BYTES = 2 * 1024 * 1024;

/** Each command writes a running and a done event, so this keeps about 100 commands. */
const COMPUTER_COMMAND_HISTORY_EVENTS = 200;

/**
 * The store that keeps earlier versions of this computer's home. A computer that works in a copy
 * on a host keeps its own files there, so restoring a stored version could not reach them.
 */
function versionedHomeStore(home: AgentHomeStore, kind: string) {
  if (!(home instanceof ObjectAgentHomeStore)) return undefined;
  if (sandboxKindCapabilities(kind).storedHomeIsBackup) return undefined;
  return home;
}

/** A path the caller typed that leaves the workspace is theirs to fix. */
function callerWorkspacePath(resolve: () => string): string {
  try {
    return resolve();
  } catch (error) {
    if (error instanceof WorkspacePathError) throw new ClientError("BAD_REQUEST", error.message);
    throw error;
  }
}

/** The server's file limit, lowered to what the computer's own transport can carry. */
function transferMaxBytes(deps: RouterContext["deps"], kind: string) {
  return Math.min(
    attachmentMaxBytes(deps.env),
    sandboxKindCapabilities(kind).maxFileBytes ?? Number.POSITIVE_INFINITY,
  );
}

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
              await wakeableComputerRef(deps.prisma, bot.computer),
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
        const lease = await acquireBootLease(deps.prisma, {
          computerId: bot.computer.id,
          runId: manualRunId,
          botId: bot.id,
        });
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
          // The bot was deleted or moved to another computer while this boot waited.
          if (isRecordNotFound(error)) {
            throw new ClientError("NOT_FOUND", "Computer no longer exists");
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
            ...computerUsingRuns(),
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
            },
          });
          if (stopped.count !== 1) return computerStatus(deps, context.actor, input.botId);
          await recordComputerRunEnd(deps.prisma, bot.computer, end);
          await endTeachingWithLease(deps, context.actor.spaceId, controlLeaseId);
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
        if (!sandboxKindCapabilities(bot.computer.kind).inPlaceUpdate)
          throw new ORPCError("BAD_REQUEST", {
            message: "Computer recovery is not available on this device",
          });
        try {
          const update = await queueComputerUpdate(deps, bot.computer.id, bot.id, "recover");
          deps.analytics?.capture(context.actor.userId, {
            name: "computer_repair_started",
            action: "recover",
          });
          return update;
        } finally {
          // A refused start can still have dismissed earlier failures.
          await deps.events.publishSpaceChange?.(context.actor.spaceId, "computerUpdates");
        }
      }),
      reset: authed.computer.reset.handler(async ({ context, input }) => {
        const status = await runComputerReplace(deps, context, input.botId, "reset", "reset");
        // Counted once the reset ran, so a refused request is not a repair.
        deps.analytics?.capture(context.actor.userId, {
          name: "computer_repair_started",
          action: "reset",
        });
        return status;
      }),
      update: authed.computer.update.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        if (!bot.computer) throw new IsolationError();
        assertNotAnotherPersonsControl(bot.computer, context.actor);
        if (!sandboxKindCapabilities(bot.computer.kind).inPlaceUpdate)
          throw new ORPCError("BAD_REQUEST", {
            message: "Computer update is not available on this device",
          });
        try {
          return await queueComputerUpdate(deps, bot.computer.id, bot.id);
        } finally {
          await deps.events.publishSpaceChange?.(context.actor.spaceId, "computerUpdates");
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
        const dismissed = await deps.prisma.computerUpdate.updateMany({
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
        if (dismissed.count > 0)
          await deps.events.publishSpaceChange?.(context.actor.spaceId, "computerUpdates");
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
      homeVersions: authed.computer.homeVersions.handler(async ({ context, input }) => {
        const computer = (await repos.getBot(context.actor, input.botId)).computer;
        if (!computer) return [];
        const store = versionedHomeStore(deps.home, computer.kind);
        if (!store) return [];
        const versions = await store.earlierVersions(computer.homeKey);
        return versions.map((version) => ({
          id: version.revision,
          savedAt: version.savedAt.toISOString(),
        }));
      }),
      restoreHomeVersion: authed.computer.restoreHomeVersion.handler(async ({ context, input }) => {
        const computer = (await repos.getBot(context.actor, input.botId)).computer;
        if (!computer) throw new IsolationError();
        assertNotAnotherPersonsControl(computer, context.actor);
        const store = versionedHomeStore(deps.home, computer.kind);
        if (!store)
          throw new ClientError("BAD_REQUEST", "Earlier versions are not kept for this computer");
        await store.restoreVersion(computer.homeKey, input.versionId);
        getLogger().info("computer.home_version_restored", { "computer.id": computer.id });
        return { ok: true as const };
      }),
      takeover: authed.computer.takeover.handler(async ({ context, input }) =>
        takeComputerControl(deps, context.actor, input.botId),
      ),
      release: authed.computer.release.handler(async ({ context, input }) => {
        // Handing back also ends a teaching recording made under this control, saved as a draft.
        const handBack = async () => {
          const bot = await repos.getBot(context.actor, input.botId);
          if (bot.computer) {
            await releaseComputerControl(
              deps,
              context.actor,
              bot.computer,
              bot.id,
              "released",
              input.leaseId,
            );
          }
        };
        if (input.reason === undefined && input.runId === undefined) {
          await handBack();
          return { ok: true as const };
        }
        // Done or Skip answers the bot's request and then hands back. A refused answer changes
        // nothing, including who controls the screen.
        const answered = await answerComputerRequest(
          deps,
          context.actor,
          input.botId,
          input.reason ?? "done",
          input.runId,
        );
        if (answered) return { ok: true as const };
        // The card waits for its answer to land, so one that changed nothing must say so.
        if (input.runId !== undefined) {
          throw new ORPCError("CONFLICT", { message: "The bot is no longer waiting" });
        }
        // The screen's I'm done with nothing waiting any more is a plain hand back.
        await handBack();
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
            deps,
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
        const storedPath = callerWorkspacePath(() =>
          resolveBotWorkspacePath(computerMode, bot.id, input.path),
        );
        let entries: Awaited<ReturnType<SandboxProvider["listFiles"]>>;
        if (computer.state === "running" && computer.providerRef) {
          await deps.prisma.computer.updateMany({
            where: { id: computer.id, state: "running" },
            data: { updatedAt: new Date() },
          });
          scheduleComputerSleep(deps.jobs, computer.id);
          const ref = await wakeableComputerRef(deps.prisma, computer);
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
        const storedPath = callerWorkspacePath(() =>
          resolveBotWorkspacePath(computerMode, bot.id, input.path),
        );
        let content: string;
        if (bot.computer.state === "running" && bot.computer.providerRef) {
          await deps.prisma.computer.updateMany({
            where: { id: bot.computer.id, state: "running" },
            data: { updatedAt: new Date() },
          });
          scheduleComputerSleep(deps.jobs, bot.computer.id);
          const bytes = await deps.sandbox
            .readFile(await wakeableComputerRef(deps.prisma, bot.computer), storedPath, ctx, {
              maxBytes: MAX_COMPUTER_TEXT_FILE_BYTES,
            })
            .catch((error: unknown) => {
              if (error instanceof SandboxFileTooLargeError) {
                throw new ClientError("BAD_REQUEST", "file is too large to preview");
              }
              throw error;
            });
          try {
            content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          } catch (error) {
            if (!(error instanceof TypeError)) throw error;
            throw new ClientError("BAD_REQUEST", "file is not a text file");
          }
        } else {
          try {
            content = await deps.home.readFile(bot.computer.homeKey, storedPath, ctx, {
              maxBytes: MAX_COMPUTER_TEXT_FILE_BYTES,
            });
          } catch (error) {
            if (error instanceof SandboxFileTooLargeError) {
              throw new ClientError("BAD_REQUEST", "file is too large to preview");
            }
            // The file browser can ask for a file deleted since it last listed.
            if (error instanceof Error && "code" in error && error.code === "ENOENT") {
              throw new ClientError("NOT_FOUND", "file not found");
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
        const storedPath = callerWorkspacePath(() =>
          resolveBotWorkspacePath(parseComputerMode(computer.scope), bot.id, input.path),
        );
        const bytes = await deps.sandbox
          .readFile(
            await wakeableComputerRef(deps.prisma, computer),
            storedPath,
            computerContext(context.actor, bot.id, "download"),
            { maxBytes: transferMaxBytes(deps, computer.kind) },
          )
          .catch((error: unknown) => {
            if (error instanceof SandboxFileTooLargeError) {
              throw new ClientError(
                "BAD_REQUEST",
                `File exceeds the ${attachmentSizeLabel(error.maxBytes)} download limit.`,
              );
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
        const maxBytes = transferMaxBytes(deps, computer.kind);
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
        const storedPath = callerWorkspacePath(() =>
          resolveBotUploadPath(parseComputerMode(computer.scope), bot.id, input.path),
        );
        await deps.sandbox.writeFile(
          await wakeableComputerRef(deps.prisma, computer),
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
          !sandboxKindCapabilities(computer.kind).terminal
        ) {
          return { url: null };
        }
        // Same rule as the interactive screen: only the user holding this bot's control lease.
        if (!holdsComputerControl(computer, bot.id, context.actor) || !computer.controlLeaseId) {
          throw new ORPCError("FORBIDDEN", { message: "Take control first." });
        }
        const session = await deps.sandbox
          .connectTerminal(
            await wakeableComputerRef(deps.prisma, computer),
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
            await wakeableComputerRef(deps.prisma, computer),
            {
              view: "stream",
              interactive: holder,
              controlToken: holder ? (computer.controlLeaseId ?? undefined) : undefined,
            },
            await computerScreenContext(deps.prisma, context.actor, computer.id, bot.id, "screen"),
          )
          .catch(async (error: unknown) => {
            if (error instanceof ComputerScreenUnavailableError) {
              throw new ClientError("CONFLICT", error.message);
            }
            return clearGoneSandbox(deps, computer, error);
          });
        if (!session?.url) return { url: null };
        if (!input.preview) scheduleComputerSleep(deps.jobs, bot.computer.id);
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
          // The view is part of what a screen shows: taking or releasing control changes it.
          ...(session.singleUseSignIn
            ? {
                singleUseSignIn: {
                  screen: `${session.singleUseSignIn.screen}:${holder ? "control" : "view"}`,
                },
              }
            : {}),
        };
      }),
      preview: authed.computer.preview.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        const computer = bot.computer;
        if (!computer?.providerRef || computer.state !== "running") return { image: null };
        // A card shows the screen only while its run waits, before and after the capture.
        const stillWaiting = async () =>
          !input.runId ||
          Boolean(await waitingTakeoverRun(deps, context.actor.spaceId, bot.id, input.runId));
        if (!(await stillWaiting())) return { image: null };
        const observation = await deps.sandbox
          .observe(
            await wakeableComputerRef(deps.prisma, computer),
            await computerScreenContext(deps.prisma, context.actor, computer.id, bot.id, "screen"),
          )
          .catch(async (error: unknown) => {
            if (isSandboxGoneError(error)) return clearGoneSandbox(deps, computer, error);
            getLogger().warn("computer.preview_failed", { error });
            return null;
          });
        if (!observation || !(await stillWaiting())) return { image: null };
        const data = Buffer.from(observation.image).toString("base64");
        return { image: `data:${observation.mimeType};base64,${data}` };
      }),
      heartbeat: authed.computer.heartbeat.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        if (bot.computer && holdsComputerControl(bot.computer, bot.id, context.actor)) {
          await renewComputerControl(
            deps,
            bot.computer.id,
            bot.computer.controlLeaseId!,
            controlLeaseExpiresAt(),
          );
        }
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
