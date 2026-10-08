import { randomUUID } from "node:crypto";
import type { AgentRuntime, JobPublisher } from "@rakazo/adapter-kit";
import { runJobKey } from "@rakazo/adapter-kit";
import { MessagingTeamChatEmulator } from "@rakazo/adapters";
import type { ModelConnectInput, RunStatus } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES, isTerminal } from "@rakazo/core";
import type { createDb } from "@rakazo/db";
import { discardBotIntroRun } from "../discard-bot-intro.js";
import { sessionCookieHeader } from "../index.js";
import type { EvalCase, Evidence } from "./cases.js";
import type { ClarificationBlock } from "./clarification.js";
import { expectedClarificationText } from "./clarification.js";
import type { DiagnosticToolObservation, HistoryDiagnostic } from "./history-observer.js";
import type { CacheDecisionMeasurement, EvalPricing } from "./measurement.js";
import { measureCalls } from "./measurement.js";
import type { FailureCategory, TrialResult } from "./report.js";
import { emptyTrial, redact } from "./report.js";
import { EvalServices } from "./services.js";
import type { LedgerCall } from "./step-accounting.js";
import { measureWorkflowSteps } from "./step-accounting.js";

type App = { request: (input: string, init?: RequestInit) => Promise<Response> | Response };
export type EvalApp = {
  app: App;
  prisma: ReturnType<typeof createDb>["prisma"];
  jobs: JobPublisher;
  runtime: AgentRuntime;
  harnessIssues?: readonly string[];
  connector?: { records: readonly unknown[] };
  awaitIdle?: () => Promise<void>;
  finalizeBackground?: () => Promise<void>;
  cacheDecisions?: readonly CacheDecisionMeasurement[];
  historyDiagnostics?: readonly HistoryDiagnostic[];
  toolLoopDiagnostics?: readonly DiagnosticToolObservation[];
  backgroundFailures?: () => Array<{ name: string; count: number }>;
  stop: () => Promise<void>;
};
export type EvalActor = {
  botId: string;
  cookie: string;
  userId: string;
  spaceId: string;
};
export type TrialOptions = {
  pricing?: EvalPricing;
  connection: ModelConnectInput;
  timeoutMs: number;
  maxToolCalls: number;
  createApp: (services: EvalServices, messaging: MessagingTeamChatEmulator) => Promise<EvalApp>;
};
class EvalFailure extends Error {
  constructor(
    readonly category: FailureCategory,
    message: string,
  ) {
    super(message);
  }
}

/** No coaching retries: scenario setup turns are intentional steps, never repair prompts. */
export async function runTrial(
  scenario: EvalCase,
  trial: number,
  options: TrialOptions,
): Promise<TrialResult> {
  const result = emptyTrial(scenario.id, trial);
  const started = Date.now();
  const deadline = started + options.timeoutMs;
  const services = new EvalServices();
  const messaging = new MessagingTeamChatEmulator({
    provider: "slack",
    capabilities: { groups: false },
  });
  scenario.configure?.(services);
  let handles: EvalApp | undefined;
  let cookie = "";
  let botId = "";
  let seededThreadId: string | undefined;
  const runIds: string[] = [];
  const runSteps = new Map<string, number>();
  const setupRunIds = new Set<string>();
  const actors: EvalActor[] = [];
  let pendingApproval: Evidence["pendingApproval"] = null;
  let approvalPending = false;
  let clarificationPending = false;
  let priorMemory = "";
  let messagingLinked = false;
  let messagingAddress = "";
  let messagingOriginThreadId: string | null = null;
  const secrets = [options.connection.apiKey ?? "", options.connection.baseUrl ?? ""];
  let phase: FailureCategory = "harness";
  const seenTools = new Map<string, { name: string }>();
  let clearedToolCount = 0;
  const seenUsage = new Map<string, LedgerCall>();
  const countCurrentTools = () =>
    handles!.prisma.event.count({
      where: { spaceId: { in: actors.map((actor) => actor.spaceId) }, type: "agent.tool.called" },
    });
  // Clearing removes conversation events while the durable usage ledger remains.
  // Deduplicate observed records by id so multi-turn totals and budgets never reset.
  const captureTools = async () => {
    if (!handles) return seenTools.size;
    const events = await handles.prisma.event.findMany({
      where: {
        spaceId: { in: actors.map((actor) => actor.spaceId) },
        type: "agent.tool.called",
        ...(seenTools.size ? { id: { notIn: [...seenTools.keys()] } } : {}),
      },
      select: { id: true, payload: true },
    });
    for (const event of events)
      seenTools.set(event.id, {
        name: redact(String((event.payload as { name?: string }).name ?? "unknown"), secrets),
      });
    return seenTools.size;
  };
  const captureUsage = async () => {
    if (!handles) return;
    const usage = await handles.prisma.usageRecord.findMany({
      where: { OR: actorScopes(actors) },
    });
    for (const row of usage)
      seenUsage.set(row.id, {
        ...row,
        operation:
          row.operationKind === "answer" && row.runId && setupRunIds.has(row.runId)
            ? "setup"
            : row.operationKind,
      });
  };
  try {
    handles = await options.createApp(services, messaging);
    const trial = handles;
    const { app, prisma } = trial;
    const setupActor = async () => {
      const signup = await app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
        body: JSON.stringify({
          email: `eval-${randomUUID()}@example.test`,
          password: "synthetic-eval-password-12",
          name: "Eval User",
        }),
      });
      if (!signup.ok) throw new EvalFailure("harness", `Fixture signup failed (${signup.status})`);
      cookie = sessionCookieHeader(signup);
      await rpc(app, cookie, "models/connect", options.connection);
      for (const provider of scenario.connections ?? ["GMAIL", "CRM", "GITHUB"])
        await rpc(app, cookie, "connections/begin", {
          connectorId: "composio",
          provider,
          displayName: provider,
        });
      const bot = await rpc<{ id: string }>(app, cookie, "bots/create", {
        name: "Assistant",
        title: "",
        description: "",
        instructions: "",
        notifyOnFinish: false,
      });
      botId = bot.id;
      const persistedBot = await prisma.bot.findUniqueOrThrow({
        where: { id: botId },
        select: { userId: true, spaceId: true },
      });
      // Register before discard so a timeout still reaches cleanupActors.
      actors.push({ botId, cookie, ...persistedBot });
      await discardBotIntroRun(trial, cookie, botId);
      await rpc(app, cookie, "bots/update", {
        botId,
        modelProvider: options.connection.provider,
        modelId: options.connection.modelId,
      });
      messagingLinked = false;
      messagingAddress = `U-eval-${randomUUID()}`;
      messaging.resetWitnesses();
      if (scenario.approvalTool)
        await rpc(app, cookie, "approvalRules/set", {
          effect: "require_approval",
          matchKind: "tool",
          matchValue: scenario.approvalTool,
        });
    };
    await setupActor();
    if (scenario.history) {
      const thread = await prisma.thread.findUniqueOrThrow({
        where: { botId },
        select: { id: true },
      });
      seededThreadId = thread.id;
      // Direct synthetic fixture setup, never pay a model to author filler.
      for (let offset = 0; offset < scenario.history.messages.length; offset += 500) {
        await prisma.message.createMany({
          data: scenario.history.messages.slice(offset, offset + 500).map((m) => ({
            threadId: thread.id,
            seq: m.seq,
            role: m.role,
            blocks: [
              { kind: "text", text: m.text },
              ...(m.subagentResult
                ? [
                    {
                      kind: "subagent",
                      agentId: "synthetic-investigation",
                      name: "Investigator",
                      task: "Investigate Aurora exports",
                      status: "completed",
                      result: m.subagentResult,
                    },
                  ]
                : []),
            ],
            createdAt: m.createdAt,
            ...(m.role === "bot" ? { botId } : {}),
          })),
        });
      }
      if (scenario.history.messages.some((m) => m.subagentResult)) {
        const actor = actors[actors.length - 1]!;
        const source = await prisma.message.findUniqueOrThrow({
          where: { threadId_seq: { threadId: thread.id, seq: 12 } },
          select: { id: true },
        });
        const task = await prisma.task.create({
          data: {
            spaceId: actor.spaceId,
            userId: actor.userId,
            botId,
            threadId: thread.id,
            prompt: "Synthetic prior Aurora investigation",
            status: "completed",
          },
        });
        const linkedRun = await prisma.run.create({
          data: {
            spaceId: actor.spaceId,
            userId: actor.userId,
            botId,
            threadId: thread.id,
            taskId: task.id,
            status: "completed",
            trigger: "user",
            sourceMessageId: source.id,
            completedAt: new Date(Date.UTC(2026, 0, 1)),
          },
        });
        await prisma.message.update({
          where: { threadId_seq: { threadId: thread.id, seq: 13 } },
          data: { runId: linkedRun.id },
        });
        await prisma.artifact.create({
          data: {
            spaceId: actor.spaceId,
            userId: actor.userId,
            botId,
            runId: linkedRun.id,
            name: "aurora-investigation.txt",
            mimeType: "text/plain",
            size: 0,
            hash: "synthetic-empty",
            storageKey: "synthetic-fixture-no-content",
          },
        });
      }
      await prisma.thread.update({
        where: { id: thread.id },
        data: {
          nextMessageSeq: scenario.history.messages.length,
          ...(scenario.history.summary
            ? {
                historyCompactedUpToSeq: scenario.history.summary.upToSeq,
                historyCompactionSummary: scenario.history.summary.text,
              }
            : {}),
        },
      });
    }
    if (scenario.taughtSkill) {
      // Human-authored fixture setup via the same API as the teaching UI; no model work is prefilled.
      await rpc(app, cookie, "computer/boot", { botId });
      await rpc(app, cookie, "computer/takeover", { botId });
      const skill = await rpc<{ id: string }>(app, cookie, "skills/start", {
        botId,
        goal: "Dispatch label",
      });
      await rpc(app, cookie, "computer/input", { botId, kind: "key", payload: { key: "x" } });
      await rpc(app, cookie, "skills/stop", { skillId: skill.id });
      await rpc(app, cookie, "skills/updateDraft", {
        skillId: skill.id,
        name: "Dispatch label",
        playbook: {
          whenToUse: "When asked to run Dispatch label for a city and item count.",
          inputs: ["city", "item count"],
          steps: [
            "Convert city to uppercase and item count to digits.",
            "Write results/dispatch.txt in your home, containing CITY | COUNT | PACKED with the actual values. For example PARIS | 2 | PACKED.",
          ],
          howToCheck: "Read the file and verify the city, count and PACKED marker.",
          whatToReturn: "The saved file path.",
          approvalBoundaries: "No connected-app writes are part of this workflow.",
          failureHandling: "Report a missing input; do not invent it.",
        },
      });
      await rpc(app, cookie, "skills/save", { skillId: skill.id, name: "Dispatch label" });
    }
    phase = "product";
    let lastText = "";
    const replies: string[] = [];
    for (const [stepIndex, step] of scenario.steps.entries()) {
      if (Date.now() >= deadline) throw new EvalFailure("incomplete", "Trial time budget exceeded");
      if ("newWorkspace" in step) {
        priorMemory = (await rpc<Array<{ content: string }>>(app, cookie, "memory/list", { botId }))
          .map((m) => m.content)
          .join("\n");
        await setupActor();
        continue;
      }
      if ("clear" in step) {
        await Promise.all([captureTools(), captureUsage()]);
        await rpc(app, cookie, "threads/clear", { botId });
        clearedToolCount = seenTools.size - (await countCurrentTools());
        continue;
      }
      let runId: string;
      if ("ask" in step) {
        runId = (
          await rpc<{ runId: string }>(app, cookie, "threads/send", { botId, text: step.ask })
        ).runId;
      } else if ("slack" in step) {
        if (!messagingLinked) {
          const link = await rpc<{ code: string }>(app, cookie, "messaging/link/start", { botId });
          await messaging.emitInbound({
            isDirect: true,
            from: messagingAddress,
            fromLabel: "Teammate",
            content: link.code,
          });
          await poll(async () => (messaging.sent.length > 0 ? true : undefined), deadline);
          messaging.resetWitnesses();
          messagingLinked = true;
        }
        const inbound = await messaging.emitInbound({
          isDirect: true,
          from: messagingAddress,
          fromLabel: "Teammate",
          content: step.slack,
        });
        messagingOriginThreadId = inbound.threadId;
        runId = await poll(
          async () =>
            (
              await prisma.run.findFirst({
                where: {
                  botId,
                  sourceMessage: {
                    is: {
                      clientNonce: `messaging:${inbound.provider}:${inbound.handle}`,
                    },
                  },
                },
                orderBy: { createdAt: "desc" },
                select: { id: true },
              })
            )?.id,
          deadline,
        );
      } else {
        const routines = await prisma.routine.findMany({ where: { botId } });
        if (routines.length !== 1)
          throw new EvalFailure("agent", "Expected exactly one authored routine");
        const routine = routines[0]!;
        if (!routine.active || !routine.crons.length)
          throw new EvalFailure("agent", "Authored routine was not scheduled");
        // Force the scheduler's clock edge, not the agent's work. Attribution starts after setup.
        services.calls.length = 0;
        services.seedGithubReleases([
          {
            owner: "example",
            repo: "widget",
            tag: "v2.2.0",
            name: "Widget 2.2",
            body: "Adds CSV import validation.",
            publishedAt: "2026-01-03T09:00:00Z",
            htmlUrl: "https://example.test/widget/releases/v2.2.0",
          },
          ...services.listGithubReleases(),
        ]);
        const scheduledFor = new Date(Date.now() - 1_000);
        await prisma.routine.update({
          where: { id: routine.id },
          data: { nextRunAt: scheduledFor },
        });
        await handles.jobs.enqueue({
          name: "routine.wakeup",
          payload: { routineId: routine.id, scheduledFor: scheduledFor.toISOString() },
        });
        runId = await poll(
          async () =>
            (
              await prisma.run.findFirst({
                where: { botId, routineId: routine.id, id: { notIn: runIds } },
                orderBy: { createdAt: "desc" },
              })
            )?.id,
          deadline,
        );
      }
      runIds.push(runId);
      runSteps.set(runId, stepIndex + 1);
      if (
        scenario.steps
          .slice(stepIndex + 1)
          .some((next) => "ask" in next || "slack" in next || "wakeRoutine" in next)
      )
        setupRunIds.add(runId);
      const requestStarted = (
        await prisma.run.findUniqueOrThrow({ where: { id: runId }, select: { createdAt: true } })
      ).createdAt.getTime();
      let seenToolCount = result.toolCalls;
      const terminal = await poll(async () => {
        const [run, toolCount] = await Promise.all([
          prisma.run.findUnique({ where: { id: runId }, select: { status: true, error: true } }),
          countCurrentTools().then((count) => count + clearedToolCount),
        ]);
        seenToolCount = toolCount;
        if (result.firstResponseMs === null) {
          const visible = await prisma.event.findFirst({
            where: {
              runId,
              type: "thread.progress",
              payload: { path: ["streaming"], equals: true },
            },
            orderBy: { seq: "asc" },
            select: { createdAt: true },
          });
          if (visible)
            result.firstResponseMs = Math.max(0, visible.createdAt.getTime() - requestStarted);
        }
        if (toolCount > options.maxToolCalls)
          throw new EvalFailure("incomplete", "Tool call budget exceeded");
        if (
          run?.status === "waiting_input" &&
          (scenario.approvalTool || scenario.expectedClarification)
        )
          return run;
        if (run && ["waiting_input", "waiting_approval", "paused"].includes(run.status))
          throw new EvalFailure("agent", "Agent requested assistance; no coaching supplied");
        return run && isTerminal(run.status as RunStatus) ? run : undefined;
      }, deadline);
      if (result.firstResponseMs === null) {
        const firstMessage = await prisma.message.findFirst({
          where: { runId, role: "bot" },
          orderBy: { seq: "asc" },
          select: { createdAt: true },
        });
        if (firstMessage)
          result.firstResponseMs = Math.max(0, firstMessage.createdAt.getTime() - requestStarted);
      }
      const events = await prisma.event.findMany({
        where: { runId, type: "agent.tool.called" },
        orderBy: { seq: "asc" },
      });
      result.toolCalls = seenToolCount;
      result.trace.push({
        step: stepIndex + 1,
        status: terminal.status,
        tools: events.map((e) =>
          redact(String((e.payload as { name?: string }).name ?? "unknown"), secrets),
        ),
      });
      if (
        terminal.status !== "completed" &&
        !(
          (scenario.approvalTool || scenario.expectedClarification) &&
          terminal.status === "waiting_input"
        )
      ) {
        // Provider attribution requires recognizable protocol/auth evidence; unknown runtime failures remain product failures.
        const error = terminal.error ?? "Run did not complete";
        const category =
          /\b(?:401|402|403|429)\b|rate.?limit|invalid api.?key|authentication.*(?:failed|error)/i.test(
            error,
          )
            ? "provider"
            : "product";
        throw new EvalFailure(category, error);
      }
      if ("slack" in step && terminal.status === "completed") {
        await waitForMessagingDelivery(prisma, runId, deadline);
      }
      const snap = await rpc<{
        messages: Array<{
          role: string;
          runId?: string | null;
          blocks: ClarificationBlock[];
        }>;
      }>(app, cookie, "threads/get", { botId });
      approvalPending =
        terminal.status === "waiting_input" &&
        snap.messages.some((m) =>
          m.blocks.some((b) => b.kind === "ask" && typeof b.approvalEffectId === "string"),
        );
      pendingApproval = approvalPending
        ? await prisma.externalEffect.findFirst({
            where: {
              runId,
              status: "intended",
              id: {
                in: snap.messages.flatMap((m) =>
                  m.blocks.flatMap((b) => (b.approvalEffectId ? [b.approvalEffectId] : [])),
                ),
              },
            },
            select: { kind: true, request: true },
          })
        : null;
      lastText = snap.messages
        .filter((m) => m.role === "bot" && m.runId === runId)
        .flatMap((m) => m.blocks.filter((b) => b.kind === "text").map((b) => b.text ?? ""))
        .join("\n");
      if (scenario.expectedClarification && terminal.status === "waiting_input") {
        const clarification = expectedClarificationText(
          true,
          terminal.status,
          events.map((event) => String((event.payload as { name?: string }).name ?? "")),
          snap.messages
            .filter((message) => message.runId === runId && message.role === "bot")
            .flatMap((message) => message.blocks),
        );
        if (clarification === null)
          throw new EvalFailure(
            "agent",
            "Expected clarification did not contain a valid pending ask_user choice",
          );
        clarificationPending = true;
        lastText = [lastText, clarification].filter(Boolean).join("\n");
      }
      replies.push(lastText);
      if (/Eval spend cap|stopped scheduling inference|no configured pricing/i.test(lastText))
        throw new EvalFailure("incomplete", lastText);
      if (
        /unknown model|invalid api.?key|authentication.*(?:failed|error)|\b(?:401|402|403|429)\b/i.test(
          lastText,
        )
      )
        throw new EvalFailure("provider", lastText);
    }
    const files: Evidence["files"] = {};
    for (const path of scenario.files ?? []) {
      try {
        files[path] = (
          await rpc<{ content: string }>(handles.app, cookie, "computer/readFile", { botId, path })
        ).content;
      } catch {
        files[path] = null;
      }
    }
    const memories = await rpc<Array<{ content: string }>>(handles.app, cookie, "memory/list", {
      botId,
    });
    const routines = await handles.prisma.routine.findMany({
      where: { botId },
      select: { name: true, prompt: true, crons: true, active: true },
    });
    await captureTools();
    const evidence: Evidence = {
      text: lastText,
      replies,
      files,
      records: services.records,
      notes: services.notes,
      calls: services.calls,
      routines,
      memory: memories.map((m) => m.content).join("\n"),
      approvalPending,
      clarificationPending,
      pendingApproval,
      priorMemory,
      destinationWrites: handles.connector?.records.length ?? 0,
      toolNames: [...seenTools.values()].map((event) => event.name),
      messaging: {
        originThreadId: messagingOriginThreadId,
        outbound: structuredClone(messaging.sent),
      },
    };
    phase = "harness";
    result.criteria = scenario.grade(evidence);
    result.status =
      result.criteria.length > 0 && result.criteria.every((c) => c.pass) ? "passed" : "failed";
    result.category = result.status === "passed" ? null : "agent";
    result.reason = result.status === "passed" ? null : "Outcome criteria failed";
    if (result.status === "failed" && handles.harnessIssues?.length) {
      result.category = "harness";
      result.reason = handles.harnessIssues.join(" ");
    }
    result.artifacts = Object.fromEntries(
      Object.entries({
        ...files,
        "final-response": lastText,
        ...(scenario.history && replies.length > 1
          ? Object.fromEntries(replies.map((reply, index) => [`turn-${index + 1}-response`, reply]))
          : {}),
        "memory-snapshot": evidence.memory,
      }).map(([key, value]) => [key, value === null ? null : redact(value, secrets)]),
    );
  } catch (error) {
    result.status = "failed";
    result.category = error instanceof EvalFailure ? error.category : phase;
    result.reason = redact(
      error instanceof Error ? error.message : "Unknown eval failure",
      secrets,
    );
  } finally {
    if (handles) {
      try {
        if (handles.awaitIdle) await withinDeadline(handles.awaitIdle(), deadline);
      } catch {
        result.cleanupFailed = true;
      }
      try {
        await cleanupActors(handles, actors);
      } catch {
        result.cleanupFailed = true;
      }
      try {
        await handles.finalizeBackground?.();
      } catch {
        result.cleanupFailed = true;
      }
      try {
        if (seededThreadId) {
          const state = await handles.prisma.thread.findUnique({
            where: { id: seededThreadId },
            select: {
              historyCompactedUpToSeq: true,
              historyCompactionSummary: true,
              historyCompactionGeneration: true,
            },
          });
          if (state)
            result.historyPreparationState = {
              beforeCursor: scenario.history?.summary?.upToSeq ?? null,
              afterCursor: state.historyCompactedUpToSeq,
              remainingMessages: await handles.prisma.message.count({
                where: {
                  threadId: seededThreadId,
                  ...(state.historyCompactedUpToSeq !== null
                    ? { seq: { gt: state.historyCompactedUpToSeq } }
                    : {}),
                },
              }),
              summaryPresent: !!state.historyCompactionSummary?.trim(),
              generation: state.historyCompactionGeneration,
            };
        }
        result.backgroundFailures = Object.fromEntries(
          (handles.backgroundFailures?.() ?? []).map(({ name, count }) => [name, count]),
        );
      } catch {
        result.cleanupFailed = true;
      }
      await captureUsage().catch(() => {
        result.cleanupFailed = true;
      });
      Object.assign(
        result,
        measureCalls(
          [...seenUsage.values()],
          options.pricing,
          options.connection.cacheCapabilities?.minimumTokens,
        ),
      );
      result.stepAccounting = measureWorkflowSteps(
        [...seenUsage.values()],
        runSteps,
        options.pricing,
        options.connection.cacheCapabilities?.minimumTokens,
      );
      result.cacheDecisions = handles.cacheDecisions ? [...handles.cacheDecisions] : [];
      result.historyDiagnostics = handles.historyDiagnostics ? [...handles.historyDiagnostics] : [];
      result.toolLoopDiagnostics = handles.toolLoopDiagnostics
        ? [...handles.toolLoopDiagnostics]
        : [];
      // Include interrupted and cleared-run calls without retaining raw arguments or ids in reports.
      await captureTools().catch(() => undefined);
      const events = [...seenTools.values()];
      result.toolCalls = events.length;
      if (events.length > options.maxToolCalls) {
        result.status = "failed";
        result.category = "incomplete";
        result.reason = "Tool call budget exceeded";
      }
      if (!result.trace.length && events.length)
        result.trace.push({
          step: 0,
          status: "interrupted",
          tools: events.map((event) => event.name),
        });
    }
    try {
      await handles?.stop();
    } catch {
      result.cleanupFailed = true;
    }
    if (result.cleanupFailed) {
      result.status = "failed";
      result.category = "harness";
      result.reason = "Fixture cleanup failed; remaining trials must not start";
    }
    result.latencyMs = Date.now() - started;
  }
  return result;
}

async function rpc<T>(app: App, cookie: string, proc: string, body: unknown = {}): Promise<T> {
  const res = await app.request(`/rpc/${proc}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: "http://127.0.0.1:5173" },
    body: JSON.stringify({ json: body }),
    signal: AbortSignal.timeout(15_000),
  });
  const parsed = (await res.json()) as { json?: T; error?: unknown };
  if (!res.ok || parsed.error) throw new Error(`${proc} failed (${res.status})`);
  return parsed.json as T;
}

async function poll<T>(read: () => Promise<T | undefined>, deadline: number): Promise<T> {
  while (Date.now() < deadline) {
    const result = await read();
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new EvalFailure("incomplete", "Trial time budget exceeded");
}

async function waitForMessagingDelivery(
  prisma: EvalApp["prisma"],
  runId: string,
  deadline: number,
): Promise<void> {
  await poll(
    async () =>
      (
        await prisma.run.findUnique({
          where: { id: runId },
          select: { messagingMirroredAt: true },
        })
      )?.messagingMirroredAt ?? undefined,
    deadline,
  );
  const messages = await prisma.message.findMany({
    where: { runId, role: "bot" },
    select: { id: true },
  });
  await poll(async () => {
    const outbound = await prisma.messagingOutbound.findMany({
      where: { sourceMessageId: { in: messages.map((message) => message.id) } },
      select: { status: true, providerHandle: true },
    });
    return outbound.length > 0 &&
      outbound.every((row) => row.providerHandle !== null || row.status === "failed")
      ? true
      : undefined;
  }, deadline);
}

function actorScopes(actors: readonly EvalActor[]) {
  return actors.map(({ userId, spaceId }) => ({ userId, spaceId }));
}

async function findScopeBots(
  prisma: EvalApp["prisma"],
  actors: readonly EvalActor[],
): Promise<Array<{ id: string; userId: string; spaceId: string }>> {
  if (!actors.length) return [];
  return prisma.bot.findMany({
    where: { OR: actorScopes(actors) },
    select: { id: true, userId: true, spaceId: true },
  });
}

function cookieForBot(bot: { userId: string; spaceId: string }, actors: readonly EvalActor[]) {
  return actors.find((actor) => actor.userId === bot.userId && actor.spaceId === bot.spaceId)
    ?.cookie;
}

/** Disable scheduled work and stop every run in each isolated actor scope. */
export async function cleanupActors(
  handles: Pick<EvalApp, "app" | "prisma" | "jobs" | "runtime">,
  actors: readonly EvalActor[],
): Promise<void> {
  if (!actors.length) return;
  const failures: unknown[] = [];
  const scopes = actorScopes(actors);
  let stable = false;

  // A parent can finish spawning a child while its abort is settling. Repeat until
  // every bot and run visible after abort was included in the pass.
  for (let pass = 0; pass < 8; pass++) {
    let bots: Array<{ id: string; userId: string; spaceId: string }> = actors.map((actor) => ({
      id: actor.botId,
      userId: actor.userId,
      spaceId: actor.spaceId,
    }));
    let runsBeforeStop: Array<{ id: string }> = [];
    try {
      await handles.prisma.routine.updateMany({
        where: { OR: scopes },
        data: { active: false, nextRunAt: null },
      });
    } catch (error) {
      failures.push(error);
    }

    try {
      bots = await findScopeBots(handles.prisma, actors);
    } catch (error) {
      failures.push(error);
    }
    try {
      runsBeforeStop = await handles.prisma.run.findMany({
        where: { OR: scopes },
        select: { id: true },
      });
    } catch (error) {
      failures.push(error);
    }

    for (const bot of bots) {
      const actorCookie = cookieForBot(bot, actors);
      if (!actorCookie) {
        failures.push(new Error("No actor session for scoped bot"));
        continue;
      }
      try {
        await rpc(handles.app, actorCookie, "threads/stop", { botId: bot.id });
      } catch (error) {
        failures.push(error);
      }
    }

    let runsAfterStop: Array<{ id: string }> = [];
    try {
      runsAfterStop = await handles.prisma.run.findMany({
        where: { OR: scopes },
        select: { id: true },
      });
    } catch (error) {
      failures.push(error);
    }
    const handledRunIds = new Set([...runsBeforeStop, ...runsAfterStop].map((run) => run.id));
    for (const runId of handledRunIds) {
      try {
        await handles.jobs.cancel(runJobKey(runId));
      } catch (error) {
        failures.push(error);
      }
    }
    for (const runId of handledRunIds) {
      try {
        await handles.runtime.abort(runId);
      } catch (error) {
        failures.push(error);
      }
    }

    let botsAfter: Array<{ id: string; userId: string; spaceId: string }> | undefined;
    let runsAfter: Array<{ id: string; status: string }> | undefined;
    let activeRoutineCount: number | undefined;
    try {
      await handles.prisma.routine.updateMany({
        where: { OR: scopes },
        data: { active: false, nextRunAt: null },
      });
      [botsAfter, runsAfter, activeRoutineCount] = await Promise.all([
        findScopeBots(handles.prisma, actors),
        handles.prisma.run.findMany({
          where: { OR: scopes },
          select: { id: true, status: true },
        }),
        handles.prisma.routine.count({ where: { OR: scopes, active: true } }),
      ]);
    } catch (error) {
      failures.push(error);
    }

    if (
      botsAfter &&
      runsAfter &&
      activeRoutineCount === 0 &&
      botsAfter.every((bot) => bots.some((stopped) => stopped.id === bot.id)) &&
      runsAfter.every(
        (run) =>
          handledRunIds.has(run.id) &&
          !(ACTIVE_RUN_STATUSES as readonly string[]).includes(run.status),
      )
    ) {
      stable = true;
      break;
    }
  }
  if (!stable) failures.push(new Error("Trial scope did not become idle"));
  if (failures.length) throw new Error("Trial work could not be stopped", { cause: failures });
}

async function withinDeadline<T>(work: Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Background work exceeded trial deadline")),
          Math.max(1, deadline - Date.now()),
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
