import type {
  AdapterContext,
  AgentHomeStore,
  AgentModelOAuthCredential,
  AgentRuntime,
  ArtifactStore,
  ComputerRef,
  ConnectorProvider,
  JobPublisher,
  MemoryStore,
  NotificationMessage,
  NotificationProvider,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import { historyCompactJob, routineWakeupJob, runContinueJob } from "@rakazo/adapter-kit";
import type { MessageBlock, RunStatus } from "@rakazo/contracts";
import { ATTACHMENT_MAX_BYTES, isAttachmentImageMimeType } from "@rakazo/contracts";
import {
  assertTransition,
  blocksToAgentHistoryText,
  containsSecret,
  createStreamingRedactor,
  inferAttachmentMimeType,
  isTerminal,
  nextCronDate,
  nextFence,
  redactSecrets,
  sandboxCommandTimeoutMs,
  userTurnBlocksForRun,
} from "@rakazo/core";
import {
  createThreadMessage,
  findDefaultModelCredential,
  type PrismaClient,
  parseComputerMode,
  type ThreadEvents,
} from "@rakazo/db";
import { builtinAgentTools } from "./builtin-tools.js";
import { archiveSpawnedBot, spawnBot } from "./child-bots.js";
import { collectLogIds } from "./composio-connector.js";
import { scheduleComputerSleep } from "./computer-idle.js";
import {
  acquireComputerExecutionLease,
  ComputerBusyError,
  type ComputerExecutionLease,
  holdComputerExecutionLeaseForTakeover,
  provisionComputer,
  releaseComputerExecutionLease,
  renewComputerExecutionLease,
  screenLeaseIdForRun,
} from "./computer-lifecycle.js";
import { withComputerScreenAvailability } from "./computer-screens.js";
import {
  displayBotWorkspacePath,
  resolveBotWorkspaceCwd,
  resolveBotWorkspacePath,
  teamBotWorkspaceDirectory,
} from "./computer-support.js";
import { observationToolResult, parseComputerActions } from "./computer-tools.js";
import { checkpointAndRecordComputerWorkspace } from "./computer-workspace.js";
import {
  COMPACTION_BATCH_SIZE,
  formatRecalledMemory,
  HISTORY_WINDOW_SIZE,
  historyWindowSize,
  LEGACY_HISTORY_WINDOW_SIZE,
  shouldEnqueueCompaction,
} from "./history-compaction.js";
import { loadAgentMemoryContext } from "./memory-context.js";
import { toOAuthCredential } from "./pi-credentials.js";
import {
  parseModelSecret,
  resolveModelAuth,
  secretValuesToRedact,
  serializeModelSecret,
} from "./pi-oauth.js";
import { inferScript } from "./scripted-runtime.js";
import type { EncryptedSecretStore } from "./secrets.js";
import {
  isSupermemoryEnabled,
  searchSupermemory,
  supermemoryContainerTag,
} from "./supermemory-client.js";
import {
  attachWorkspaceFileToThread,
  currentTurnFilesInstruction,
  materializeCurrentTurnFiles,
} from "./thread-artifacts.js";

const modelCredentialLocks = new Map<string, Promise<void>>();
const READ_ONLY_AGENT_TOOLS = new Set([
  "computer_observe",
  "list_files",
  "read_file",
  "request_takeover",
  "run_subagent",
]);
const MAX_MODEL_FILE_BYTES = 250_000;
const GRAPHICAL_AGENT_TOOLS = new Set([
  "computer_observe",
  "computer_act",
  "open_path",
  "launch_app",
]);

export interface ExecutorDeps {
  prisma: PrismaClient;
  events: ThreadEvents;
  runtime: AgentRuntime;
  sandbox: SandboxProvider;
  memory: MemoryStore;
  home: AgentHomeStore;
  artifacts?: ArtifactStore;
  connector?: ConnectorProvider;
  secrets: string[];
  secretStore?: EncryptedSecretStore;
  deploymentModelKey?: string;
  dataDir?: string;
  notifications?: NotificationProvider;
  jobs: JobPublisher;
}

export async function deferFutureRoutine(
  jobs: JobPublisher,
  routineId: string,
  scheduledAt: Date,
): Promise<boolean> {
  if (scheduledAt.getTime() <= Date.now() + 1_000) return false;
  await jobs.enqueue(routineWakeupJob(routineId, scheduledAt));
  return true;
}

export function createRunExecutor(deps: ExecutorDeps) {
  return {
    async wakeRoutine(routineId: string, scheduledFor: string) {
      const scheduledAt = new Date(scheduledFor);
      if (!Number.isFinite(scheduledAt.getTime())) return;
      const routine = await deps.prisma.routine.findUnique({ where: { id: routineId } });
      if (!routine?.active || routine.nextRunAt?.getTime() !== scheduledAt.getTime()) return;
      if (await deferFutureRoutine(deps.jobs, routineId, scheduledAt)) return;
      const bot = await deps.prisma.bot.findUnique({
        where: { id: routine.botId },
        include: { thread: true },
      });
      if (!bot?.thread) return;
      const nextRunAt = nextCronDate(
        routine.cron,
        new Date(Math.max(Date.now(), scheduledAt.getTime())),
        routine.timezone,
      );
      const claimed = await deps.prisma.$transaction(async (tx) => {
        const updated = await tx.routine.updateMany({
          where: { id: routine.id, active: true, nextRunAt: scheduledAt },
          data: { lastRunAt: new Date(), nextRunAt },
        });
        if (updated.count !== 1) return null;
        const task = await tx.task.create({
          data: {
            workspaceId: routine.workspaceId,
            botId: bot.id,
            threadId: bot.thread!.id,
            userId: routine.userId,
            prompt: routine.prompt,
            status: "queued",
          },
        });
        return tx.run.create({
          data: {
            workspaceId: routine.workspaceId,
            botId: bot.id,
            threadId: bot.thread!.id,
            taskId: task.id,
            userId: routine.userId,
            status: "queued",
            trigger: "routine",
          },
        });
      });
      if (!claimed) return;
      await deps.events.append({
        workspaceId: routine.workspaceId,
        threadId: bot.thread.id,
        botId: bot.id,
        type: "routine.fired",
        runId: claimed.id,
        payload: { routineId: routine.id, scheduledFor },
      });
      await deps.jobs.enqueue(routineWakeupJob(routine.id, nextRunAt));
      await deps.jobs.enqueue(runContinueJob(claimed.id));
    },

    async continueRun(runId: string, workerId: string) {
      const run = await deps.prisma.run.findUnique({ where: { id: runId } });
      if (!run) return;
      if (isTerminal(run.status as RunStatus)) return;
      const resumeFromTakeover = run.status === "waiting_takeover";

      const fence = nextFence(run.leaseFence);
      const now = new Date();
      const leased = await deps.prisma.run.updateMany({
        where: {
          id: runId,
          OR: [
            { status: { in: ["queued", "waiting_input", "waiting_takeover"] } },
            {
              status: { in: ["leased", "running"] },
              leaseExpiresAt: { lte: now },
            },
          ],
        },
        data: {
          status: "leased",
          leaseOwner: workerId,
          leaseFence: fence,
          leaseExpiresAt: new Date(Date.now() + 5 * 60_000),
          error: null,
        },
      });
      if (leased.count !== 1) return;

      const current = await deps.prisma.run.findUniqueOrThrow({ where: { id: runId } });
      if (
        current.status === "queued" ||
        current.status === "leased" ||
        current.status === "waiting_input" ||
        current.status === "waiting_takeover"
      ) {
        assertTransition(current.status as RunStatus, "running");
      }
      const started = await deps.prisma.run.updateMany({
        where: { id: runId, status: "leased", leaseOwner: workerId, leaseFence: fence },
        data: { status: "running", startedAt: current.startedAt ?? new Date() },
      });
      if (started.count !== 1) return;
      const leaseTarget = await deps.prisma.bot.findUniqueOrThrow({
        where: { id: run.botId },
        select: { computerId: true, computerSwitching: true },
      });
      if (!leaseTarget.computerId) throw new Error("Bot has no computer");
      if (leaseTarget.computerSwitching) {
        await requeueComputerRun(deps, runId, workerId, fence);
        return;
      }
      let computerLease: ComputerExecutionLease | null = null;
      try {
        computerLease = await acquireComputerExecutionLease(deps.prisma, {
          computerId: leaseTarget.computerId,
          runId,
          botId: run.botId,
          resumeHeldLease: resumeFromTakeover,
        });
      } catch (error) {
        if (!(error instanceof ComputerBusyError)) throw error;
        await requeueComputerRun(deps, runId, workerId, fence);
        return;
      }
      const attempt = await deps.prisma.attempt
        .create({
          data: { runId, fence, status: "running" },
        })
        .catch(async (error) => {
          await releaseComputerExecutionLease(deps.prisma, computerLease).catch(() => undefined);
          throw error;
        });

      let leaseValid = true;
      let lastLeaseCheckAt = 0;
      let retainComputerLease = false;
      let screenRelease: { computer: ComputerRef; context: AdapterContext } | undefined;
      let runAbortController: AbortController | null = null;
      const heartbeat = setInterval(() => {
        void Promise.all([
          renewRunLease(deps, runId, workerId, fence),
          renewComputerExecutionLease(deps.prisma, computerLease),
        ])
          .then(([runRenewed, computerRenewed]) => {
            if (!runRenewed || !computerRenewed) {
              leaseValid = false;
              runAbortController?.abort();
            }
          })
          .catch(() => {
            leaseValid = false;
            runAbortController?.abort();
          });
      }, 60_000);
      heartbeat.unref?.();

      const runSecrets = [...deps.secrets];
      try {
        const [bot, thread, messages, task, connectedPlugins, credential, settings] =
          await Promise.all([
            deps.prisma.bot.findUniqueOrThrow({
              where: { id: run.botId },
              include: { computer: true },
            }),
            deps.prisma.thread.findUniqueOrThrow({ where: { id: run.threadId } }),
            deps.prisma.message.findMany({
              where: { threadId: run.threadId },
              orderBy: { seq: "desc" },
              take: LEGACY_HISTORY_WINDOW_SIZE,
              select: { role: true, runId: true, blocks: true },
            }),
            deps.prisma.task.findUniqueOrThrow({ where: { id: run.taskId } }),
            deps.prisma.connection.findMany({
              where: { userId: run.userId, workspaceId: run.workspaceId, status: "connected" },
              select: { provider: true, displayName: true },
            }),
            findDefaultModelCredential(deps.prisma, run),
            deps.prisma.deploymentSettings.findUnique({ where: { id: "default" } }),
          ]);
        runAbortController = new AbortController();
        if (!leaseValid) runAbortController.abort();
        const context = {
          operationId: runId,
          traceId: runId,
          workspaceId: run.workspaceId,
          userId: run.userId,
          botId: bot.id,
          runId,
          screenLeaseId: screenLeaseIdForRun(computerLease, runId, fence),
          signal: runAbortController.signal,
          connectedProviders: connectedPlugins.map((row) => row.provider),
        };

        await deps.events.append({
          workspaceId: run.workspaceId,
          threadId: thread.id,
          botId: bot.id,
          type: "run.started",
          runId,
          payload: { trigger: run.trigger },
        });

        const discovered = deps.connector ? await deps.connector.discoverTools(context) : [];
        let history = [...messages].reverse().map((m) => ({
          role: (m.role === "user" ? "user" : m.role === "system" ? "system" : "assistant") as
            | "user"
            | "assistant"
            | "system",
          content: blocksToAgentHistoryText(m.blocks as MessageBlock[]),
        }));
        const turnBlocks = userTurnBlocksForRun(
          run.trigger,
          runId,
          messages.map((message) => ({
            role: message.role,
            runId: message.runId,
            blocks: message.blocks as MessageBlock[],
          })),
        );
        const currentTurnImages = await loadCurrentTurnImages(deps, turnBlocks, context);
        const memoryContext = await loadAgentMemoryContext(deps.memory, bot.id, context);
        const supermemoryEnabled = isSupermemoryEnabled(process.env.SUPERMEMORY_API_KEY);
        let recalledMemory = "";
        let recallSucceeded = false;
        if (supermemoryEnabled && thread.historyCompactedUpToSeq != null) {
          const recalled = await searchSupermemory(task.prompt, supermemoryContainerTag(bot.id));
          if (recalled.ok) {
            recallSucceeded = true;
            recalledMemory = formatRecalledMemory(recalled.results);
          } else {
            console.error("supermemory recall failed", recalled.error);
          }
        }
        history = history.slice(
          -historyWindowSize({
            supermemoryEnabled,
            compacted: thread.historyCompactedUpToSeq != null,
            recallSucceeded,
          }),
        );
        const resolved = await resolveModelKey(
          deps,
          run.userId,
          run.workspaceId,
          credential,
          (values) => runSecrets.push(...values),
        );
        runSecrets.push(...resolved.redact);
        if (!bot.computer) throw new Error("Bot has no computer");
        const storedComputer = bot.computer;
        const computerMode = parseComputerMode(storedComputer.scope);
        const computer = await provisionComputer(deps, storedComputer.id, context, "bot");
        screenRelease = { computer, context };
        scheduleComputerSleep(deps.jobs, storedComputer.id);
        const currentTurnFiles = deps.artifacts
          ? await materializeCurrentTurnFiles(
              { prisma: deps.prisma, artifacts: deps.artifacts, sandbox: deps.sandbox },
              turnBlocks,
              { context, computer, computerMode },
            )
          : [];
        const attachedFilesPrompt = currentTurnFilesInstruction(currentTurnFiles);
        const graphical =
          computer.kind !== "desktop" && deps.sandbox.describe().capabilities.graphical;
        const builtins = graphical
          ? builtinAgentTools
          : builtinAgentTools.filter((tool) => !GRAPHICAL_AGENT_TOOLS.has(tool.name));
        const tools = [
          ...builtins,
          ...discovered.filter(
            (tool) => !builtinAgentTools.some((builtin) => builtin.name === tool.name),
          ),
        ];
        const computerInstruction = graphical
          ? "You have a persistent computer. Use computer_observe and computer_act for its visible desktop, including browsers and installed applications. Use open_path and launch_app to open graphical files, URLs, and applications. Use the file tools and shell for precise filesystem and terminal work. On a Team Computer you have your own screen; other Team bots may run at the same time on theirs. Another user may interact with your screen while you run, so re-observe when it may have changed."
          : "You have a persistent sandbox filesystem and shell. This backend does not provide model-visible graphical control, so use the file tools and shell.";
        const workspaceInstruction =
          computerMode === "team"
            ? `Your Team Computer home is ${teamBotWorkspaceDirectory(bot.id)}. Relative file paths and shell working directories start there. Put intentionally shared work under shared/. Other bots' folders are visible under bots/; treat them as their working areas.`
            : "This entire computer workspace is your private home. Relative file paths and shell working directories start at its root.";

        let assembled = "";
        let pendingProgress = "";
        let lastProgressAt = 0;
        let lastComputerFrameId: string | undefined;
        let terminalCheckpointComplete = false;
        const progressRedactor = createStreamingRedactor(runSecrets);
        const scripted = deps.runtime.describe().capabilities.scripted;
        const script = scripted
          ? inferScript(task.prompt, resumeFromTakeover ? "takeover" : undefined)
          : undefined;
        const formatObservation = (
          observation: Awaited<ReturnType<SandboxProvider["observe"]>>,
          note?: string,
        ) => {
          const result = observationToolResult(observation, note, lastComputerFrameId);
          lastComputerFrameId = observation.frameId;
          return result;
        };

        const applyTool = async (
          name: string,
          args: Record<string, unknown>,
          executionId: string,
        ) => {
          const applied = READ_ONLY_AGENT_TOOLS.has(name)
            ? undefined
            : await recordEffect(deps, run, name, executionId, args);
          if (applied?.duplicate) {
            if (applied.effect.status === "completed") {
              return applied.effect.result ?? { duplicate: true };
            }
            if (name !== "spawn_bot" && name !== "archive_bot" && name !== "delete_bot") {
              throw new Error(`tool ${name} has an earlier execution with an uncertain outcome`);
            }
          }
          const finish = async (result: unknown) => {
            if (applied) await completeEffect(deps, applied.effect.id, result);
            return result;
          };
          if (name === "computer_observe") {
            return computerScreenToolResult(async () =>
              formatObservation(await deps.sandbox.observe(computer, context)),
            );
          }
          if (name === "computer_act") {
            return computerScreenToolResult(async () => {
              const result = await deps.sandbox.act(
                computer,
                {
                  actions: parseComputerActions(args.actions),
                  observe: args.observe !== false,
                  settleMs: Number(args.settle_ms ?? 350),
                },
                context,
              );
              return result.observation
                ? formatObservation(
                    result.observation,
                    `completed ${result.completed} computer action${result.completed === 1 ? "" : "s"}`,
                  )
                : { ok: true, completed: result.completed };
            }, finish);
          }
          if (name === "list_files") {
            const requestedPath = String(args.path ?? "");
            const entries = await deps.sandbox.listFiles(
              computer,
              resolveBotWorkspacePath(computerMode, bot.id, requestedPath),
              context,
            );
            return {
              path: requestedPath,
              entries: entries.map((entry) => ({
                ...entry,
                path: displayBotWorkspacePath(computerMode, bot.id, requestedPath, entry.path),
              })),
            };
          }
          if (name === "read_file") {
            const filePath = String(args.path ?? "");
            const storedPath = resolveBotWorkspacePath(computerMode, bot.id, filePath);
            let bytes: Uint8Array;
            try {
              bytes = await deps.sandbox.readFile(computer, storedPath, context, {
                maxBytes: MAX_MODEL_FILE_BYTES,
              });
            } catch (error) {
              if (error instanceof Error && /exceeds \d+ bytes/.test(error.message)) {
                return {
                  error: "file is too large for model context",
                  path: filePath,
                };
              }
              throw error;
            }
            if (bytes.byteLength > MAX_MODEL_FILE_BYTES) {
              return {
                error: "file is too large for model context",
                path: filePath,
                size: bytes.byteLength,
              };
            }
            try {
              return {
                path: filePath,
                content: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
              };
            } catch {
              return {
                error: "file is not UTF-8 text; use open_path to inspect it",
                path: filePath,
              };
            }
          }
          if (name === "write_file") {
            const filePath = String(args.path ?? "notes/result.txt");
            const content = String(args.content ?? "");
            await deps.sandbox.writeFile(
              computer,
              {
                path: resolveBotWorkspacePath(computerMode, bot.id, filePath),
                content: new TextEncoder().encode(content),
              },
              context,
            );
            return finish({ ok: true, path: filePath });
          }
          if (name === "attach_file") {
            const filePath = String(args.path ?? "");
            if (!deps.artifacts) {
              return finish({ error: "artifact storage unavailable", path: filePath });
            }
            const storedPath = resolveBotWorkspacePath(computerMode, bot.id, filePath);
            let bytes: Uint8Array;
            try {
              bytes = await deps.sandbox.readFile(computer, storedPath, context, {
                maxBytes: ATTACHMENT_MAX_BYTES,
              });
            } catch {
              return finish({ error: "file not found or unreadable", path: filePath });
            }
            const mimeType = inferAttachmentMimeType(filePath);
            if (!mimeType) {
              return finish({ error: "unsupported attachment type", path: filePath });
            }
            try {
              const attached = await attachWorkspaceFileToThread(
                { prisma: deps.prisma, artifacts: deps.artifacts },
                {
                  workspaceId: run.workspaceId,
                  userId: run.userId,
                  botId: bot.id,
                  runId: run.id,
                  filePath,
                  bytes,
                  operationId: executionId,
                },
              );
              await publishMessage(deps, run, "bot", [attached.block]);
              return finish({ ok: true, artifactId: attached.artifactId, path: filePath });
            } catch (error) {
              return finish({
                error: error instanceof Error ? error.message : "could not attach file",
                path: filePath,
              });
            }
          }
          if (name === "shell") {
            const command = String(args.command ?? args.cmd ?? "");
            const cwd = resolveBotWorkspaceCwd(
              computerMode,
              bot.id,
              args.cwd ? String(args.cwd) : undefined,
            );
            const result = await runSandboxCommand(
              deps.sandbox,
              computer,
              ["bash", "-lc", command],
              cwd,
              context,
            );
            return finish(result);
          }
          if (name === "open_path") {
            const requestedPath = String(args.path ?? "");
            return computerScreenToolResult(async () => {
              const result = await deps.sandbox.act(
                computer,
                {
                  actions: [
                    {
                      kind: "open",
                      path: /^https?:\/\//i.test(requestedPath)
                        ? requestedPath
                        : resolveBotWorkspacePath(computerMode, bot.id, requestedPath),
                    },
                  ],
                  observe: true,
                  settleMs: 600,
                },
                context,
              );
              return result.observation
                ? formatObservation(result.observation, `opened ${requestedPath}`)
                : { ok: true };
            }, finish);
          }
          if (name === "launch_app") {
            const application = String(args.application ?? "");
            return computerScreenToolResult(async () => {
              const result = await deps.sandbox.act(
                computer,
                {
                  actions: [
                    {
                      kind: "launch",
                      application,
                      uri: args.uri ? String(args.uri) : undefined,
                    },
                  ],
                  observe: true,
                  settleMs: 600,
                },
                context,
              );
              return result.observation
                ? formatObservation(result.observation, `launched ${application}`)
                : { ok: true };
            }, finish);
          }
          if (name === "remember") {
            await deps.memory.commit(
              {
                scope: "bot",
                botId: bot.id,
                path: String(args.path ?? "MEMORY.md"),
                content: String(args.content ?? ""),
                sourceRunId: runId,
                sourceThreadId: thread.id,
              },
              context,
            );
            return finish({ ok: true });
          }
          if (name === "request_takeover") return { ok: true };
          if (name === "run_subagent") {
            return {
              ok: true,
              result: String(args.task ?? "done."),
            };
          }
          if (name === "spawn_bot") {
            const spawned = await spawnBot(deps, {
              spawnedBy: {
                id: bot.id,
                name: bot.name,
                workspaceId: bot.workspaceId,
                userId: run.userId,
              },
              runId,
              spawnKey: executionId,
              name: String(args.name ?? ""),
              title: args.title ? String(args.title) : undefined,
              instructions: args.instructions ? String(args.instructions) : undefined,
              prompt: args.prompt ? String(args.prompt) : undefined,
            });
            if ("error" in spawned) return finish(spawned);
            await finish(spawned);
            try {
              await publishMessage(deps, run, "bot", [
                {
                  kind: "child_bot",
                  botId: spawned.botId,
                  name: spawned.name,
                  title: spawned.title,
                  status: "created",
                },
              ]);
              await deps.events.append({
                workspaceId: run.workspaceId,
                threadId: thread.id,
                botId: bot.id,
                runId: run.id,
                type: "bot.spawned",
                payload: { childBotId: spawned.botId, name: spawned.name },
              });
            } catch (error) {
              console.error("spawned bot notification", error);
            }
            return spawned;
          }
          if (name === "archive_bot" || name === "delete_bot") {
            const archived = await archiveSpawnedBot(
              deps,
              {
                spawnedByBotId: bot.id,
                userId: run.userId,
                workspaceId: run.workspaceId,
                confirmName: String(args.confirm_name ?? args.confirmName ?? ""),
                botId: args.bot_id
                  ? String(args.bot_id)
                  : args.botId
                    ? String(args.botId)
                    : undefined,
              },
              context,
            );
            if ("error" in archived) return finish(archived);
            await finish(archived);
            try {
              await publishMessage(deps, run, "bot", [
                {
                  kind: "child_bot",
                  botId: archived.botId,
                  name: archived.name,
                  status: "archived",
                },
              ]);
              await deps.events.append({
                workspaceId: run.workspaceId,
                threadId: thread.id,
                botId: bot.id,
                runId: run.id,
                type: "bot.archived",
                payload: { childBotId: archived.botId, name: archived.name },
              });
            } catch (error) {
              console.error("archived bot notification", error);
            }
            return archived;
          }
          if (deps.connector) {
            let result: unknown = { error: `unknown tool ${name}` };
            for await (const event of deps.connector.execute(
              { tool: name, args, executionId },
              context,
            )) {
              if (event.type === "result") {
                result = event.data;
                const logIds = collectLogIds(event.data);
                for (const logId of logIds) {
                  await deps.events.append({
                    workspaceId: run.workspaceId,
                    threadId: thread.id,
                    botId: bot.id,
                    runId: run.id,
                    type: "effect.recorded",
                    payload: { tool: name, logId },
                  });
                }
              }
              if (event.type === "error") result = { error: event.message };
            }
            return finish(result);
          }
          return finish({ error: `unknown tool ${name}` });
        };

        const pluginLine =
          connectedPlugins.length > 0
            ? `Connected plugins: ${connectedPlugins.map((row) => `${row.displayName} (${row.provider})`).join(", ")}. Use those plugin tools when the user asks about those apps.`
            : "No plugins are connected yet.";

        try {
          for await (const event of deps.runtime.run(
            {
              botId: bot.id,
              threadId: thread.id,
              runId,
              prompt: [task.prompt, attachedFilesPrompt].filter(Boolean).join("\n\n"),
              instructions: [
                bot.instructions || `${bot.name}: ${bot.title}\n${bot.description}`,
                memoryContext ? redactSecrets(memoryContext, runSecrets) : undefined,
                recalledMemory ? redactSecrets(recalledMemory, runSecrets) : undefined,
                `${computerInstruction} Use remember for durable facts. Use request_takeover when the user must provide protected input or human judgment. Use destination_write only for connected destination records.`,
                workspaceInstruction,
                "A bot and a subagent are different. Never use both for the same request.",
                "spawn_bot creates a lasting regular bot (own chat, computer, memory) that appears in the user's bot list. If the user asked to create a bot, call spawn_bot once and stop. Do not run_subagent to demo it.",
                "run_subagent is a short helper inside this turn only. It is not a bot, has no thread, and does not show in the list. Use it for parallel work you will summarize here.",
                "archive_bot safely archives a bot this bot created, and only that bot. Use it when the user asks to remove that bot or when it is finished and unused. The user can restore it or permanently delete it later. confirm_name must exactly match its name.",
                pluginLine,
                "Never print API keys, access tokens, or secret values. Prefer tools over claiming you already did the work.",
              ]
                .filter((instruction): instruction is string => Boolean(instruction))
                .join("\n\n"),
              history,
              currentTurnImages,
              tools,
              model: {
                provider: credential?.provider ?? settings?.defaultModelProvider ?? "scripted",
                id: credential?.defaultModel ?? settings?.defaultModelId ?? "scripted",
                apiKey: resolved.oauth ? undefined : resolved.apiKey,
                oauth: resolved.oauth
                  ? { credential: resolved.oauth, persist: resolved.persistOAuth }
                  : undefined,
              },
              resumeFromCheckpoint: resumeFromTakeover ? "takeover" : undefined,
              script,
              executeTool: scripted ? undefined : applyTool,
            },
            context,
          )) {
            if (!leaseValid) return;
            const now = Date.now();
            if (now - lastLeaseCheckAt >= 1_000) {
              lastLeaseCheckAt = now;
              const still = await deps.prisma.run.findUnique({
                where: { id: runId },
                select: { status: true, leaseOwner: true, leaseFence: true },
              });
              if (
                !still ||
                still.status === "cancelled" ||
                still.leaseOwner !== workerId ||
                still.leaseFence !== fence
              ) {
                leaseValid = false;
                return;
              }
            }

            if (event.type === "text") {
              assembled += event.text;
              pendingProgress += progressRedactor.push(event.text);
              const now = Date.now();
              if (!scripted && pendingProgress && now - lastProgressAt >= 250) {
                lastProgressAt = now;
                await deps.events.append({
                  workspaceId: run.workspaceId,
                  threadId: thread.id,
                  botId: bot.id,
                  type: "thread.progress",
                  runId,
                  payload: { delta: pendingProgress, streaming: true },
                });
                pendingProgress = "";
              }
            } else if (event.type === "progress") {
              await deps.events.append({
                workspaceId: run.workspaceId,
                threadId: thread.id,
                botId: bot.id,
                type: "thread.progress",
                runId,
                payload: { text: redactSecrets(event.text, runSecrets) },
              });
            } else if (event.type === "ask") {
              if (!(await renewRunLease(deps, runId, workerId, fence))) return;
              const safeText = redactSecrets(event.text, runSecrets);
              const safeDetail = event.detail
                ? redactSecrets(event.detail, runSecrets)
                : event.detail;
              await checkpointAndRecordComputerWorkspace(deps, storedComputer, computer, context);
              const paused = await deps.events.pauseRunForInput({
                workspaceId: run.workspaceId,
                threadId: run.threadId,
                botId: run.botId,
                runId,
                attemptId: attempt.id,
                leaseOwner: workerId,
                leaseFence: fence,
                blocks: [{ kind: "ask", text: safeText, detail: safeDetail, status: "pending" }],
              });
              if (!paused) return;
              await notifyRun(deps, run, {
                kind: "help",
                title: `${bot.name} needs an answer`,
                body: safeText,
                botId: bot.id,
                threadId: thread.id,
              });
              return;
            } else if (event.type === "takeover") {
              if (!(await renewRunLease(deps, runId, workerId, fence))) return;
              const safeReason = redactSecrets(event.reason, runSecrets);
              if (assembled.trim()) {
                await publishMessage(deps, run, "bot", [
                  { kind: "text", text: redactSecrets(assembled, runSecrets) },
                ]);
              }
              await publishMessage(deps, run, "bot", [
                { kind: "computer", state: "Ready", text: safeReason },
              ]);
              await deps.events.append({
                workspaceId: run.workspaceId,
                threadId: thread.id,
                botId: bot.id,
                type: "computer.takeover.requested",
                runId,
                payload: { reason: safeReason },
              });
              await deps.prisma.computer.updateMany({
                where: { id: storedComputer.id },
                data: {
                  state: "running",
                  controlHolder: "none",
                  controlLeaseId: null,
                  controlLeaseExpiresAt: null,
                  controlBotId: null,
                },
              });
              await checkpointAndRecordComputerWorkspace(deps, storedComputer, computer, context);
              if (!(await holdComputerExecutionLeaseForTakeover(deps.prisma, computerLease))) {
                throw new Error("Computer lease expired before takeover");
              }
              const paused = await deps.prisma.run.updateMany({
                where: { id: runId, status: "running", leaseOwner: workerId, leaseFence: fence },
                data: { status: "waiting_takeover", leaseOwner: null, leaseExpiresAt: null },
              });
              if (paused.count !== 1) return;
              retainComputerLease = true;
              await deps.prisma.attempt.update({
                where: { id: attempt.id },
                data: { status: "waiting_takeover", finishedAt: new Date() },
              });
              await clearRunProgress(deps, runId);
              await notifyRun(deps, run, {
                kind: "takeover",
                title: `${bot.name} needs you on the screen`,
                body: safeReason,
                botId: bot.id,
                threadId: thread.id,
              });
              return;
            } else if (event.type === "tool") {
              await deps.events.append({
                workspaceId: run.workspaceId,
                threadId: thread.id,
                botId: bot.id,
                type: "agent.tool.called",
                runId,
                payload: { name: event.name, executionId: event.executionId },
              });
              if (scripted) await applyTool(event.name, event.args, event.executionId);
            } else if (event.type === "subagent") {
              const safeTask = redactSecrets(event.task, runSecrets);
              const safeProgress = event.progress
                ? redactSecrets(event.progress, runSecrets)
                : undefined;
              const safeResult = event.result ? redactSecrets(event.result, runSecrets) : undefined;
              await deps.events.append({
                workspaceId: run.workspaceId,
                threadId: thread.id,
                botId: bot.id,
                type: "thread.subagent",
                runId,
                payload: {
                  agentId: event.agentId,
                  name: event.name,
                  task: safeTask,
                  status: event.status,
                  progress: safeProgress,
                  result: safeResult,
                },
              });
              if (event.status === "completed" || event.status === "failed") {
                await publishMessage(deps, run, "bot", [
                  {
                    kind: "subagent",
                    agentId: event.agentId,
                    name: event.name,
                    task: safeTask,
                    status: event.status,
                    progress: safeProgress,
                    result: safeResult,
                  },
                ]);
              }
            } else if (event.type === "usage") {
              await deps.prisma.usageRecord.create({
                data: {
                  workspaceId: run.workspaceId,
                  botId: bot.id,
                  userId: run.userId,
                  runId,
                  provider: event.provider,
                  model: event.model,
                  inputTokens: event.inputTokens,
                  outputTokens: event.outputTokens,
                },
              });
            } else if (event.type === "done") {
              assembled = assembled || event.text || assembled;
            }
          }

          for (const turn of script ?? []) {
            for (const file of turn.files ?? []) {
              await deps.sandbox.writeFile(
                computer,
                {
                  path: resolveBotWorkspacePath(computerMode, bot.id, file.path),
                  content: new TextEncoder().encode(file.content),
                },
                context,
              );
            }
            for (const mem of turn.memory ?? []) {
              await deps.memory.commit(
                {
                  scope: mem.scope,
                  botId: mem.scope === "bot" ? bot.id : undefined,
                  path: mem.path,
                  content: mem.content,
                  sourceRunId: runId,
                  sourceThreadId: thread.id,
                },
                context,
              );
              await deps.events.append({
                workspaceId: run.workspaceId,
                threadId: thread.id,
                botId: bot.id,
                type: "memory.revised",
                runId,
                payload: { path: mem.path, scope: mem.scope },
              });
            }
          }

          await checkpointAndRecordComputerWorkspace(deps, storedComputer, computer, context);
          terminalCheckpointComplete = true;

          const text = redactSecrets(assembled || "done.", runSecrets);
          if (containsSecret(text, runSecrets)) {
            throw new Error("refusing to persist a secret in the thread");
          }
          if (!(await renewRunLease(deps, runId, workerId, fence))) return;
          const completed = await deps.events.finalizeRun({
            workspaceId: run.workspaceId,
            threadId: thread.id,
            botId: bot.id,
            runId,
            taskId: run.taskId,
            attemptId: attempt.id,
            leaseOwner: workerId,
            leaseFence: fence,
            outcome: "completed",
            blocks: [{ kind: "text", text }],
          });
          if (!completed) return;
          if (bot.notifyOnFinish) {
            await notifyRun(deps, run, {
              kind: "completion",
              title: `${bot.name} finished`,
              body: text.slice(0, 180),
              botId: bot.id,
              threadId: thread.id,
            });
          }
          // Last, and never fatal: the run is already finalized, so a failure here must not reach
          // the catch block below, where a second finalizeRun would match no rows and silently
          // skip the completion notification.
          if (isSupermemoryEnabled(process.env.SUPERMEMORY_API_KEY)) {
            try {
              const updatedThread = await deps.prisma.thread.findUniqueOrThrow({
                where: { id: thread.id },
                select: { nextMessageSeq: true, historyCompactedUpToSeq: true },
              });
              if (
                shouldEnqueueCompaction(
                  updatedThread.nextMessageSeq,
                  updatedThread.historyCompactedUpToSeq,
                  HISTORY_WINDOW_SIZE,
                  COMPACTION_BATCH_SIZE,
                )
              ) {
                await deps.jobs.enqueue(historyCompactJob(thread.id));
              }
            } catch (error) {
              console.error("history.compact enqueue failed", error);
            }
          }
        } catch (error) {
          if (!terminalCheckpointComplete) {
            await checkpointAndRecordComputerWorkspace(
              deps,
              storedComputer,
              computer,
              context,
            ).catch(() => undefined);
          }
          const message = redactSecrets(
            error instanceof Error ? error.message : String(error),
            runSecrets,
          );
          const failed = await deps.events.finalizeRun({
            workspaceId: run.workspaceId,
            threadId: thread.id,
            botId: bot.id,
            runId,
            taskId: run.taskId,
            attemptId: attempt.id,
            leaseOwner: workerId,
            leaseFence: fence,
            outcome: "failed",
            error: message,
          });
          if (!failed) return;
          if (bot.notifyOnFinish) {
            await notifyRun(deps, run, {
              kind: "failure",
              title: `${bot.name} failed`,
              body: message.slice(0, 180),
              botId: bot.id,
              threadId: thread.id,
            });
          }
        }
      } catch (setupError) {
        const computerBusy = setupError instanceof ComputerBusyError;
        if (!computerBusy) {
          console.error(
            "run setup failed",
            redactSecrets(
              setupError instanceof Error ? setupError.message : String(setupError),
              runSecrets,
            ),
          );
        }
        const released = await deps.prisma.run.updateMany({
          where: { id: runId, status: "running", leaseOwner: workerId, leaseFence: fence },
          data: {
            status: "queued",
            error: computerBusy ? null : "Run setup failed; retrying",
            leaseOwner: null,
            leaseExpiresAt: null,
          },
        });
        if (released.count === 1) {
          await deps.prisma.attempt.update({
            where: { id: attempt.id },
            data: {
              status: "setup_failed",
              error: "Run setup failed; retrying",
              finishedAt: new Date(),
            },
          });
          if (computerBusy) {
            await deps.jobs.enqueue({
              ...runContinueJob(runId),
              availableAt: new Date(Date.now() + computerRetryDelay(fence)),
            });
            return;
          }
          throw new Error("Run setup failed; retrying");
        }
      } finally {
        clearInterval(heartbeat);
        if (!retainComputerLease) {
          if (screenRelease) {
            await deps.sandbox
              .releaseScreen?.(screenRelease.computer, screenRelease.context)
              .catch(() => undefined);
          }
          await releaseComputerExecutionLease(deps.prisma, computerLease).catch(() => undefined);
        }
        await deps.prisma.attempt
          .updateMany({
            where: { id: attempt.id, status: "running" },
            data: { status: "interrupted", finishedAt: new Date() },
          })
          .catch(() => undefined);
      }
    },
  };
}

async function computerScreenToolResult(
  work: () => Promise<unknown>,
  finish?: (result: unknown) => Promise<unknown>,
) {
  const result = await withComputerScreenAvailability(work);
  return finish ? finish(result) : result;
}

async function notifyRun(
  deps: ExecutorDeps,
  run: { workspaceId: string; userId: string; botId: string; threadId: string },
  message: NotificationMessage,
) {
  if (!deps.notifications) return;
  await deps.notifications
    .send(message, {
      operationId: "notify",
      traceId: run.botId,
      workspaceId: run.workspaceId,
      userId: run.userId,
      botId: run.botId,
      signal: new AbortController().signal,
    })
    .catch((error) => {
      console.error("run notification", error);
    });
}

async function renewRunLease(
  deps: ExecutorDeps,
  runId: string,
  workerId: string,
  fence: number,
): Promise<boolean> {
  const renewed = await deps.prisma.run.updateMany({
    where: { id: runId, status: "running", leaseOwner: workerId, leaseFence: fence },
    data: { leaseExpiresAt: new Date(Date.now() + 5 * 60_000) },
  });
  return renewed.count === 1;
}

function computerRetryDelay(fence: number): number {
  return Math.min(10_000, 250 * 2 ** Math.min(Math.max(fence - 1, 0), 5));
}

async function requeueComputerRun(
  deps: ExecutorDeps,
  runId: string,
  workerId: string,
  fence: number,
): Promise<void> {
  const released = await deps.prisma.run.updateMany({
    where: { id: runId, status: "running", leaseOwner: workerId, leaseFence: fence },
    data: { status: "queued", error: null, leaseOwner: null, leaseExpiresAt: null },
  });
  if (released.count !== 1) return;
  await deps.jobs.enqueue({
    ...runContinueJob(runId),
    availableAt: new Date(Date.now() + computerRetryDelay(fence)),
  });
}

async function clearRunProgress(deps: ExecutorDeps, runId: string): Promise<void> {
  await deps.prisma.event.deleteMany({ where: { runId, type: "thread.progress" } });
}

async function publishMessage(
  deps: ExecutorDeps,
  run: { id: string; workspaceId: string; threadId: string; botId: string },
  role: "user" | "bot" | "system",
  blocks: MessageBlock[],
) {
  const message = await createThreadMessage(deps.prisma, {
    threadId: run.threadId,
    role,
    blocks,
    runId: run.id,
  });
  await deps.events.append({
    workspaceId: run.workspaceId,
    threadId: run.threadId,
    botId: run.botId,
    type: "thread.message.created",
    runId: run.id,
    payload: { messageId: message.id, role, blocks },
  });
  return message;
}

async function recordEffect(
  deps: ExecutorDeps,
  run: { id: string; workspaceId: string; threadId: string; botId: string },
  kind: string,
  executionId: string,
  request: Record<string, unknown>,
) {
  const existing = await deps.prisma.externalEffect.findUnique({
    where: { idempotencyKey: executionId },
  });
  if (existing) {
    await deps.events.append({
      workspaceId: run.workspaceId,
      threadId: run.threadId,
      botId: run.botId,
      type: "effect.reconciled",
      runId: run.id,
      payload: { executionId, kind },
    });
    return { duplicate: true, effect: existing };
  }
  const effect = await deps.prisma.externalEffect.create({
    data: {
      workspaceId: run.workspaceId,
      runId: run.id,
      kind,
      idempotencyKey: executionId,
      status: "intended",
      request: request as never,
    },
  });
  return { duplicate: false, effect };
}

async function completeEffect(deps: ExecutorDeps, effectId: string, result: unknown) {
  const storedResult =
    result &&
    typeof result === "object" &&
    (result as { kind?: unknown }).kind === "agent_tool_result" &&
    "details" in result
      ? (result as { details: unknown }).details
      : result;
  await deps.prisma.externalEffect.update({
    where: { id: effectId },
    data: { status: "completed", result: storedResult as never },
  });
}

async function runSandboxCommand(
  sandbox: SandboxProvider,
  computer: ComputerRef,
  argv: string[],
  cwd: string | undefined,
  context: {
    operationId: string;
    traceId: string;
    workspaceId: string;
    userId: string;
    botId?: string;
    runId?: string;
    signal: AbortSignal;
  },
) {
  let stdout = "";
  let stderr = "";
  let code = 0;
  for await (const event of sandbox.execute(
    computer,
    { argv, cwd, timeoutMs: sandboxCommandTimeoutMs() },
    context,
  )) {
    if (event.type === "stdout") stdout += event.data;
    if (event.type === "stderr") stderr += event.data;
    if (event.type === "exit") code = event.code;
  }
  return { stdout, stderr, code };
}

async function resolveModelKey(
  deps: ExecutorDeps,
  userId: string,
  workspaceId: string,
  credential: { secretId: string; provider: string } | null,
  registerSecrets?: (values: string[]) => void,
): Promise<{
  apiKey?: string;
  oauth?: AgentModelOAuthCredential;
  persistOAuth?: (credential: AgentModelOAuthCredential) => Promise<void>;
  redact: string[];
}> {
  if (credential && deps.secretStore) {
    return withModelCredentialLock(credential.secretId, async () => {
      const row = await deps.prisma.secret.findUnique({ where: { id: credential.secretId } });
      if (!row) return { apiKey: deps.deploymentModelKey, redact: [] };
      const plaintext = deps.secretStore!.load(row.ciphertext);
      registerSecrets?.(secretValuesToRedact(parseModelSecret(plaintext)));
      const persist = async (next: string) => {
        const stored = await deps.secretStore!.put(next, {
          operationId: "cred",
          traceId: "cred-refresh",
          workspaceId,
          userId,
          signal: new AbortController().signal,
        });
        await deps.prisma.secret.update({
          where: { id: row.id },
          data: { ciphertext: stored.ciphertext },
        });
      };
      const resolved = await resolveModelAuth(plaintext, credential.provider, {
        persist,
      });
      const oauth = resolved.secret.kind === "oauth" ? resolved.secret.credential : undefined;
      return {
        apiKey: resolved.apiKey,
        oauth,
        persistOAuth: oauth
          ? async (next) => {
              await withModelCredentialLock(credential.secretId, async () => {
                const currentRow = await deps.prisma.secret.findUnique({
                  where: { id: credential.secretId },
                });
                if (!currentRow) return;
                const current = parseModelSecret(deps.secretStore!.load(currentRow.ciphertext));
                if (current.kind === "oauth") {
                  const stored = current.credential;
                  if (stored.expires > next.expires) return;
                  if (
                    stored.access === next.access &&
                    stored.refresh === next.refresh &&
                    stored.expires === next.expires
                  ) {
                    return;
                  }
                }
                await persist(
                  serializeModelSecret({ kind: "oauth", credential: toOAuthCredential(next) }),
                );
              });
            }
          : undefined,
        redact: [...secretValuesToRedact(resolved.secret), resolved.apiKey].filter(
          (value): value is string => Boolean(value),
        ),
      };
    });
  }
  return { apiKey: deps.deploymentModelKey, redact: [] };
}

async function withModelCredentialLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = modelCredentialLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = previous.then(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  modelCredentialLocks.set(key, current);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (modelCredentialLocks.get(key) === current) modelCredentialLocks.delete(key);
  }
}

async function loadCurrentTurnImages(
  deps: ExecutorDeps,
  blocks: MessageBlock[] | undefined,
  context: {
    operationId: string;
    traceId: string;
    workspaceId: string;
    userId: string;
    botId: string;
    runId: string;
    signal: AbortSignal;
  },
) {
  if (!deps.artifacts || !blocks?.length) return undefined;
  const imageBlocks = blocks.filter(
    (block): block is Extract<MessageBlock, { kind: "image" }> => block.kind === "image",
  );
  if (!imageBlocks.length) return undefined;

  const rows = await deps.prisma.artifact.findMany({
    where: {
      id: { in: imageBlocks.map((block) => block.artifactId) },
      workspaceId: context.workspaceId,
      botId: context.botId,
    },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const images: NonNullable<import("@rakazo/adapter-kit").AgentRunRequest["currentTurnImages"]> =
    [];

  for (const block of imageBlocks) {
    const row = byId.get(block.artifactId);
    if (!row || !isAttachmentImageMimeType(block.mimeType)) continue;
    const bytes = await deps.artifacts.get(row.storageKey, context);
    images.push({
      name: block.name,
      mimeType: block.mimeType as "image/jpeg" | "image/png" | "image/webp" | "image/gif",
      data: bytes,
    });
  }

  return images.length ? images : undefined;
}
