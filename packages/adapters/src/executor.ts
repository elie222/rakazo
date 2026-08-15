import { mkdir } from "node:fs/promises";
import type {
  AgentHomeStore,
  AgentRuntime,
  ComputerRef,
  ConnectorProvider,
  MemoryStore,
  NotificationMessage,
  NotificationProvider,
  SandboxProvider,
  WakeupDriver,
} from "@rakazo/adapter-kit";
import type { Actor, MessageBlock, RunStatus } from "@rakazo/contracts";
import { assertTransition, containsSecret, nextCronDate, redactSecrets } from "@rakazo/core";
import { appendEvent, type PrismaClient } from "@rakazo/db";
import { builtinAgentTools } from "./builtin-tools.js";
import { deleteSpawnedBot, spawnBot } from "./child-bots.js";
import { collectLogIds } from "./composio-connector.js";
import { scheduleComputerSleep } from "./computer-idle.js";
import { resolveAgentHomePath } from "./home.js";
import { parseModelSecret, resolveModelApiKey, secretValuesToRedact } from "./pi-oauth.js";
import { inferScript } from "./scripted-runtime.js";
import type { EncryptedSecretStore } from "./secrets.js";

export interface ExecutorDeps {
  prisma: PrismaClient;
  runtime: AgentRuntime;
  sandbox: SandboxProvider;
  memory: MemoryStore;
  home: AgentHomeStore;
  connector?: ConnectorProvider;
  secrets: string[];
  secretStore?: EncryptedSecretStore;
  deploymentModelKey?: string;
  dataDir?: string;
  notifications?: NotificationProvider;
  wakeup?: WakeupDriver;
}

export function createRunExecutor(deps: ExecutorDeps) {
  return {
    async wakeRoutine(routineId: string, workerId: string) {
      const routine = await deps.prisma.routine.findUnique({ where: { id: routineId } });
      if (!routine?.active) return;
      const bot = await deps.prisma.bot.findUnique({
        where: { id: routine.botId },
        include: { thread: true },
      });
      if (!bot?.thread) return;
      const task = await deps.prisma.task.create({
        data: {
          workspaceId: routine.workspaceId,
          botId: bot.id,
          threadId: bot.thread.id,
          userId: routine.userId,
          prompt: routine.prompt,
          status: "queued",
        },
      });
      const run = await deps.prisma.run.create({
        data: {
          workspaceId: routine.workspaceId,
          botId: bot.id,
          threadId: bot.thread.id,
          taskId: task.id,
          userId: routine.userId,
          status: "queued",
          trigger: "routine",
        },
      });
      const lastRunAt = new Date();
      const nextRunAt = nextCronDate(routine.cron, new Date(), routine.timezone);
      await deps.prisma.routine.update({
        where: { id: routine.id },
        data: {
          lastRunAt,
          nextRunAt,
        },
      });
      await this.continueRun(run.id, workerId);
      if (deps.wakeup && !Number.isNaN(nextRunAt.getTime())) {
        await deps.wakeup.enqueue({
          name: "routine.wakeup",
          payload: { routineId: routine.id },
          runAt: nextRunAt,
          jobKey: `routine:${routine.id}`,
        });
      }
    },

    async continueRun(runId: string, workerId: string) {
      const run = await deps.prisma.run.findUnique({ where: { id: runId } });
      if (!run) return;
      if (["completed", "failed", "cancelled"].includes(run.status)) return;
      const resumeFromTakeover = run.status === "waiting_takeover";

      const fence = run.leaseFence + 1;
      const leased = await deps.prisma.run.updateMany({
        where: {
          id: runId,
          status: { in: ["queued", "waiting_input", "waiting_takeover", "leased"] },
        },
        data: {
          status: "leased",
          leaseOwner: workerId,
          leaseFence: fence,
          leaseExpiresAt: new Date(Date.now() + 5 * 60_000),
        },
      });
      if (leased.count !== 1 && run.status !== "running") {
        return;
      }

      const current = await deps.prisma.run.findUniqueOrThrow({ where: { id: runId } });
      if (
        current.status === "queued" ||
        current.status === "leased" ||
        current.status === "waiting_input" ||
        current.status === "waiting_takeover"
      ) {
        assertTransition(current.status as RunStatus, "running");
      }
      await deps.prisma.run.update({
        where: { id: runId },
        data: { status: "running", startedAt: current.startedAt ?? new Date() },
      });
      await deps.prisma.attempt.create({
        data: { runId, fence, status: "running" },
      });

      const bot = await deps.prisma.bot.findUniqueOrThrow({ where: { id: run.botId } });
      const thread = await deps.prisma.thread.findUniqueOrThrow({ where: { id: run.threadId } });
      const messages = await deps.prisma.message.findMany({
        where: { threadId: thread.id },
        orderBy: { seq: "asc" },
      });
      const task = await deps.prisma.task.findUniqueOrThrow({ where: { id: run.taskId } });
      const actor: Actor = {
        userId: run.userId,
        workspaceId: run.workspaceId,
        email: "",
        isDeploymentOwner: false,
      };
      const connectedPlugins = await deps.prisma.connection.findMany({
        where: { userId: run.userId, workspaceId: run.workspaceId, status: "connected" },
        select: { provider: true, displayName: true },
      });
      const context = {
        operationId: runId,
        traceId: runId,
        workspaceId: run.workspaceId,
        userId: run.userId,
        botId: bot.id,
        runId,
        signal: new AbortController().signal,
        connectedProviders: connectedPlugins.map((row) => row.provider),
      };

      await appendEvent(deps.prisma, {
        workspaceId: run.workspaceId,
        threadId: thread.id,
        botId: bot.id,
        type: "run.started",
        runId,
        payload: { trigger: run.trigger },
      });

      const credential = await deps.prisma.userModelCredential.findFirst({
        where: { userId: run.userId, workspaceId: run.workspaceId, isDefault: true },
      });
      const settings = await deps.prisma.deploymentSettings.findUnique({
        where: { id: "default" },
      });
      const discovered = deps.connector ? await deps.connector.discoverTools(context) : [];
      const tools = [
        ...builtinAgentTools,
        ...discovered.filter((tool) => !builtinAgentTools.some((b) => b.name === tool.name)),
      ];
      const history = messages.map((m) => ({
        role: (m.role === "user" ? "user" : m.role === "system" ? "system" : "assistant") as
          | "user"
          | "assistant"
          | "system",
        content: blocksToText(m.blocks as MessageBlock[]),
      }));
      const resolved = await resolveModelKey(deps, run.userId, run.workspaceId, credential);
      const apiKey = resolved.apiKey;
      const runSecrets = [...deps.secrets, ...resolved.redact];
      const computer = await ensureComputer(deps, bot.id, context);

      let assembled = "";
      let lastProgressAt = 0;
      const scripted = deps.runtime.describe().capabilities.scripted;
      const script = scripted
        ? inferScript(task.prompt, resumeFromTakeover ? "takeover" : undefined)
        : undefined;

      const applyTool = async (
        name: string,
        args: Record<string, unknown>,
        executionId: string,
      ) => {
        const applied = await recordEffect(deps, run, name, executionId, args);
        if (applied.duplicate) return applied.effect.result ?? { duplicate: true };
        if (name === "write_file") {
          const filePath = String(args.path ?? "notes/result.txt");
          const content = String(args.content ?? "");
          await deps.home.writeFile(bot.id, filePath, content, context);
          return { ok: true, path: filePath };
        }
        if (name === "shell") {
          const command = String(args.command ?? args.cmd ?? "");
          const cwd = String(args.cwd ?? (computer.kind === "desktop" ? "." : "/home/rakazo"));
          return runSandboxCommand(deps.sandbox, computer, ["bash", "-lc", command], cwd, context);
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
          return { ok: true };
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
            name: String(args.name ?? ""),
            title: args.title ? String(args.title) : undefined,
            instructions: args.instructions ? String(args.instructions) : undefined,
            prompt: args.prompt ? String(args.prompt) : undefined,
          });
          if ("error" in spawned) return spawned;
          await publishMessage(deps, actor, thread.id, bot.id, runId, "bot", [
            {
              kind: "child_bot",
              botId: spawned.botId,
              name: spawned.name,
              title: spawned.title,
              status: "created",
            },
          ]);
          await appendEvent(deps.prisma, {
            workspaceId: run.workspaceId,
            threadId: thread.id,
            botId: bot.id,
            runId: run.id,
            type: "bot.spawned",
            payload: { childBotId: spawned.botId, name: spawned.name },
          });
          await completeEffect(deps, applied.effect.id, spawned);
          return spawned;
        }
        if (name === "delete_bot") {
          const removed = await deleteSpawnedBot(
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
          if ("error" in removed) return removed;
          await publishMessage(deps, actor, thread.id, bot.id, runId, "bot", [
            {
              kind: "child_bot",
              botId: removed.botId,
              name: removed.name,
              status: "deleted",
            },
          ]);
          await appendEvent(deps.prisma, {
            workspaceId: run.workspaceId,
            threadId: thread.id,
            botId: bot.id,
            runId: run.id,
            type: "bot.deleted",
            payload: { childBotId: removed.botId, name: removed.name },
          });
          await completeEffect(deps, applied.effect.id, removed);
          return removed;
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
                await appendEvent(deps.prisma, {
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
          return result;
        }
        return { error: `unknown tool ${name}` };
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
            prompt: task.prompt,
            instructions: [
              bot.instructions || `${bot.name}: ${bot.title}\n${bot.description}`,
              "You have a persistent computer. Use write_file to save files into your home (they appear in Files). Use shell to run commands in that computer. Use remember for durable facts. Use request_takeover when the user must type on the screen. Use destination.write only for connected destination records.",
              "A bot and a subagent are different. Never use both for the same request.",
              "spawn_bot creates a lasting regular bot (own chat, computer, memory) that appears in the user's bot list. If the user asked to create a bot, call spawn_bot once and stop. Do not run_subagent to demo it.",
              "run_subagent is a short helper inside this turn only. It is not a bot, has no thread, and does not show in the list. Use it for parallel work you will summarize here.",
              "delete_bot permanently destroys a bot this bot created, and only that bot. Only delete when the user asked or that bot is finished and unused. confirm_name must exactly match its name.",
              pluginLine,
              "Never print API keys, access tokens, or secret values. Prefer tools over claiming you already did the work.",
            ].join("\n\n"),
            history,
            tools,
            model: {
              provider: credential?.provider ?? settings?.defaultModelProvider ?? "scripted",
              id: credential?.defaultModel ?? settings?.defaultModelId ?? "scripted",
              apiKey,
            },
            resumeFromCheckpoint: resumeFromTakeover ? "takeover" : undefined,
            script,
            executeTool: scripted ? undefined : applyTool,
          },
          context,
        )) {
          const still = await deps.prisma.run.findUnique({ where: { id: runId } });
          if (!still || still.status === "cancelled") return;

          if (event.type === "text") {
            assembled += event.text;
            const now = Date.now();
            if (!scripted && assembled.trim() && now - lastProgressAt >= 80) {
              lastProgressAt = now;
              await appendEvent(deps.prisma, {
                workspaceId: run.workspaceId,
                threadId: thread.id,
                botId: bot.id,
                type: "thread.progress",
                runId,
                payload: { text: assembled, streaming: true },
              });
            }
          } else if (event.type === "progress") {
            await appendEvent(deps.prisma, {
              workspaceId: run.workspaceId,
              threadId: thread.id,
              botId: bot.id,
              type: "thread.progress",
              runId,
              payload: { text: event.text },
            });
          } else if (event.type === "ask") {
            await publishMessage(deps, actor, thread.id, bot.id, runId, "bot", [
              { kind: "ask", text: event.text, detail: event.detail },
            ]);
            await deps.prisma.run.update({
              where: { id: runId },
              data: { status: "waiting_input" },
            });
            await notifyRun(deps, run, {
              kind: "help",
              title: `${bot.name} needs an answer`,
              body: event.text,
              botId: bot.id,
              threadId: thread.id,
            });
            return;
          } else if (event.type === "takeover") {
            if (assembled.trim()) {
              await publishMessage(deps, actor, thread.id, bot.id, runId, "bot", [
                { kind: "text", text: assembled },
              ]);
            }
            await publishMessage(deps, actor, thread.id, bot.id, runId, "bot", [
              { kind: "computer", state: "Ready", text: event.reason },
            ]);
            await appendEvent(deps.prisma, {
              workspaceId: run.workspaceId,
              threadId: thread.id,
              botId: bot.id,
              type: "computer.takeover.requested",
              runId,
              payload: { reason: event.reason },
            });
            await deps.prisma.computer.updateMany({
              where: { botId: bot.id },
              data: { state: "running", controlHolder: "none" },
            });
            await deps.prisma.run.update({
              where: { id: runId },
              data: { status: "waiting_takeover" },
            });
            await notifyRun(deps, run, {
              kind: "takeover",
              title: `${bot.name} needs you on the screen`,
              body: event.reason,
              botId: bot.id,
              threadId: thread.id,
            });
            return;
          } else if (event.type === "tool") {
            if (scripted) await applyTool(event.name, event.args, event.executionId);
          } else if (event.type === "subagent") {
            await appendEvent(deps.prisma, {
              workspaceId: run.workspaceId,
              threadId: thread.id,
              botId: bot.id,
              type: "thread.subagent",
              runId,
              payload: {
                agentId: event.agentId,
                name: event.name,
                task: event.task,
                status: event.status,
                progress: event.progress,
                result: event.result,
              },
            });
            if (event.status === "completed" || event.status === "failed") {
              await publishMessage(deps, actor, thread.id, bot.id, runId, "bot", [
                {
                  kind: "subagent",
                  agentId: event.agentId,
                  name: event.name,
                  task: event.task,
                  status: event.status,
                  progress: event.progress,
                  result: event.result,
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
            await deps.home.writeFile(bot.id, file.path, file.content, context);
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
            await appendEvent(deps.prisma, {
              workspaceId: run.workspaceId,
              threadId: thread.id,
              botId: bot.id,
              type: "memory.revised",
              runId,
              payload: { path: mem.path, scope: mem.scope },
            });
          }
        }

        const text = redactSecrets(assembled || "done.", runSecrets);
        if (containsSecret(text, runSecrets)) {
          throw new Error("refusing to persist a secret in the thread");
        }
        await publishMessage(deps, actor, thread.id, bot.id, runId, "bot", [
          { kind: "text", text },
        ]);
        await deps.prisma.run.update({
          where: { id: runId },
          data: { status: "completed", completedAt: new Date() },
        });
        await deps.prisma.task.update({
          where: { id: run.taskId },
          data: { status: "completed" },
        });
        await appendEvent(deps.prisma, {
          workspaceId: run.workspaceId,
          threadId: thread.id,
          botId: bot.id,
          type: "run.completed",
          runId,
          payload: {},
        });
        await deps.prisma.bot.update({ where: { id: bot.id }, data: { updatedAt: new Date() } });
        if (bot.notifyOnFinish) {
          await notifyRun(deps, run, {
            kind: "completion",
            title: `${bot.name} finished`,
            body: text.slice(0, 180),
            botId: bot.id,
            threadId: thread.id,
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await deps.prisma.run.update({
          where: { id: runId },
          data: { status: "failed", error: message, completedAt: new Date() },
        });
        await appendEvent(deps.prisma, {
          workspaceId: run.workspaceId,
          threadId: thread.id,
          botId: bot.id,
          type: "run.failed",
          runId,
          payload: { error: message },
        });
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
    },
  };
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
    .catch(() => undefined);
}

async function publishMessage(
  deps: ExecutorDeps,
  _actor: Actor,
  threadId: string,
  botId: string,
  runId: string,
  role: "user" | "bot" | "system",
  blocks: MessageBlock[],
) {
  const last = await deps.prisma.message.findFirst({
    where: { threadId },
    orderBy: { seq: "desc" },
  });
  const seq = (last?.seq ?? -1) + 1;
  const message = await deps.prisma.message.create({
    data: { threadId, seq, role, blocks, runId },
  });
  await appendEvent(deps.prisma, {
    workspaceId: (await deps.prisma.thread.findUniqueOrThrow({ where: { id: threadId } }))
      .workspaceId,
    threadId,
    botId,
    type: "thread.message.created",
    runId,
    payload: { messageId: message.id, role, blocks },
  });
  return message;
}

async function recordEffect(
  deps: ExecutorDeps,
  run: { id: string; workspaceId: string },
  kind: string,
  executionId: string,
  request: Record<string, unknown>,
) {
  const existing = await deps.prisma.externalEffect.findUnique({
    where: { idempotencyKey: executionId },
  });
  if (existing) {
    await appendEvent(deps.prisma, {
      workspaceId: run.workspaceId,
      threadId: (await deps.prisma.run.findUniqueOrThrow({ where: { id: run.id } })).threadId,
      botId: (await deps.prisma.run.findUniqueOrThrow({ where: { id: run.id } })).botId,
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
  await deps.prisma.externalEffect.update({
    where: { id: effect.id },
    data: { status: "completed", result: { ok: true } },
  });
  return { duplicate: false, effect };
}

async function completeEffect(deps: ExecutorDeps, effectId: string, result: unknown) {
  await deps.prisma.externalEffect.update({
    where: { id: effectId },
    data: { result: result as never },
  });
}

async function ensureComputer(
  deps: ExecutorDeps,
  botId: string,
  context: {
    operationId: string;
    traceId: string;
    workspaceId: string;
    userId: string;
    botId?: string;
    runId?: string;
    signal: AbortSignal;
  },
): Promise<ComputerRef> {
  const homePath = resolveAgentHomePath(deps.home, botId, deps.dataDir ?? "./data");
  await mkdir(homePath, { recursive: true });
  const existing = await deps.prisma.computer.findUnique({ where: { botId } });
  await deps.prisma.computer.updateMany({
    where: { botId },
    data: { state: "booting" },
  });
  try {
    const ref = await deps.sandbox.provision(
      { botId, homePath, providerRef: existing?.providerRef ?? undefined },
      context,
    );
    await deps.prisma.computer.updateMany({
      where: { botId },
      data: {
        state: "running",
        providerRef: ref.providerRef,
        kind: ref.kind,
        controlHolder: "bot",
      },
    });
    scheduleComputerSleep(deps.wakeup, botId);
    return ref;
  } catch (error) {
    await deps.prisma.computer.updateMany({
      where: { botId },
      data: { state: "error" },
    });
    throw error;
  }
}

async function runSandboxCommand(
  sandbox: SandboxProvider,
  computer: ComputerRef,
  argv: string[],
  cwd: string,
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
  for await (const event of sandbox.execute(computer, { argv, cwd }, context)) {
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
): Promise<{ apiKey?: string; redact: string[] }> {
  if (credential && deps.secretStore) {
    const row = await deps.prisma.secret.findUnique({ where: { id: credential.secretId } });
    if (row) {
      const plaintext = deps.secretStore.load(row.ciphertext);
      const parsed = parseModelSecret(plaintext);
      const apiKey = await resolveModelApiKey(plaintext, credential.provider, {
        persist: async (next) => {
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
        },
      });
      return { apiKey, redact: [...secretValuesToRedact(parsed), apiKey] };
    }
  }
  return { apiKey: deps.deploymentModelKey, redact: [] };
}

function blocksToText(blocks: MessageBlock[]): string {
  return blocks
    .map((block) => {
      if ("text" in block && block.text) return block.text;
      return JSON.stringify(block);
    })
    .join("\n");
}
