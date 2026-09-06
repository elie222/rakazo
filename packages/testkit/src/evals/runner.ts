import { randomUUID } from "node:crypto";
import type { JobPublisher } from "@rakazo/adapter-kit";
import type { ModelConnectInput, RunStatus } from "@rakazo/contracts";
import { isTerminal } from "@rakazo/core";
import type { createDb } from "@rakazo/db";
import { sessionCookieHeader } from "../index.js";
import type { EvalCase, Evidence } from "./cases.js";
import { emptyTrial, type FailureCategory, redact, type TrialResult } from "./report.js";
import { EvalServices } from "./services.js";

type App = { request: (input: string, init?: RequestInit) => Promise<Response> };
export type EvalApp = {
  app: App;
  prisma: ReturnType<typeof createDb>["prisma"];
  jobs: JobPublisher;
  connector?: { records: readonly unknown[] };
  stop: () => Promise<void>;
};
export type TrialOptions = {
  connection: ModelConnectInput;
  timeoutMs: number;
  maxToolCalls: number;
  createApp: (services: EvalServices) => Promise<EvalApp>;
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
  scenario.configure?.(services);
  let handles: EvalApp | undefined;
  let cookie = "";
  let botId = "";
  const runIds: string[] = [];
  const botIds: string[] = [];
  const actors: Array<{ botId: string; cookie: string }> = [];
  let pendingApproval: Evidence["pendingApproval"] = null;
  let approvalPending = false;
  let priorMemory = "";
  const secrets = [options.connection.apiKey ?? "", options.connection.baseUrl ?? ""];
  let phase: FailureCategory = "harness";
  try {
    handles = await options.createApp(services);
    const { app, prisma } = handles;
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
      for (const provider of ["GMAIL", "CRM", "GITHUB"])
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
      botIds.push(botId);
      actors.push({ botId, cookie });
      await rpc(app, cookie, "bots/update", {
        botId,
        modelProvider: options.connection.provider,
        modelId: options.connection.modelId,
      });
      if (scenario.approvalTool)
        await rpc(app, cookie, "approvalRules/set", {
          effect: "require_approval",
          matchKind: "tool",
          matchValue: scenario.approvalTool,
        });
    };
    await setupActor();
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
        await rpc(app, cookie, "threads/clear", { botId });
        continue;
      }
      let runId: string;
      if ("ask" in step) {
        runId = (
          await rpc<{ runId: string }>(app, cookie, "threads/send", { botId, text: step.ask })
        ).runId;
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
          ...services.listGithubReleases(),
          {
            owner: "example",
            repo: "widget",
            tag: "v2.2.0",
            name: "Widget 2.2",
            body: "Adds CSV import validation.",
            publishedAt: "2026-01-03T09:00:00Z",
            htmlUrl: "https://example.test/widget/releases/v2.2.0",
          },
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
      let seenToolCount = 0;
      const terminal = await poll(async () => {
        const [run, toolCount] = await Promise.all([
          prisma.run.findUnique({ where: { id: runId }, select: { status: true, error: true } }),
          prisma.event.count({ where: { runId, type: "agent.tool.called" } }),
        ]);
        seenToolCount = toolCount;
        if (result.toolCalls + toolCount > options.maxToolCalls)
          throw new EvalFailure("incomplete", "Tool call budget exceeded");
        if (run?.status === "waiting_input" && scenario.approvalTool) return run;
        if (run && ["waiting_input", "waiting_approval", "paused"].includes(run.status))
          throw new EvalFailure("agent", "Agent requested assistance; no coaching supplied");
        return run && isTerminal(run.status as RunStatus) ? run : undefined;
      }, deadline);
      const events = await prisma.event.findMany({
        where: { runId, type: "agent.tool.called" },
        orderBy: { seq: "asc" },
      });
      result.toolCalls += seenToolCount;
      result.trace.push({
        step: stepIndex + 1,
        status: terminal.status,
        tools: events.map((e) =>
          redact(String((e.payload as { name?: string }).name ?? "unknown"), secrets),
        ),
      });
      if (
        terminal.status !== "completed" &&
        !(scenario.approvalTool && terminal.status === "waiting_input")
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
      const snap = await rpc<{
        messages: Array<{
          role: string;
          blocks: Array<{ kind: string; text?: string; approvalEffectId?: string }>;
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
        .filter((m) => m.role === "bot")
        .flatMap((m) => m.blocks.filter((b) => b.kind === "text").map((b) => b.text ?? ""))
        .join("\n");
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
    const evidence: Evidence = {
      text: lastText,
      files,
      records: services.records,
      notes: services.notes,
      calls: services.calls,
      routines,
      memory: memories.map((m) => m.content).join("\n"),
      approvalPending,
      pendingApproval,
      priorMemory,
      destinationWrites: handles.connector?.records.length ?? 0,
    };
    phase = "harness";
    result.criteria = scenario.grade(evidence);
    result.status =
      result.criteria.length > 0 && result.criteria.every((c) => c.pass) ? "passed" : "failed";
    result.category = result.status === "passed" ? null : "agent";
    result.reason = result.status === "passed" ? null : "Outcome criteria failed";
    result.artifacts = Object.fromEntries(
      Object.entries({ ...files, "final-response": lastText }).map(([key, value]) => [
        key,
        value === null ? null : redact(value, secrets),
      ]),
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
        await cleanupActors(handles, actors);
      } catch {
        result.cleanupFailed = true;
      }
      const usage = await handles.prisma.usageRecord
        .findMany({ where: { botId: { in: botIds } } })
        .catch(() => []);
      if (usage.length) {
        result.inputTokens = usage.reduce((n, u) => n + u.inputTokens, 0);
        result.outputTokens = usage.reduce((n, u) => n + u.outputTokens, 0);
      }
      // Include interrupted-run calls too. Raw tool arguments, URLs, credentials, IDs, and errors are intentionally omitted.
      const events = await handles.prisma.event
        .findMany({
          where: { botId: { in: botIds }, type: "agent.tool.called" },
          orderBy: { seq: "asc" },
        })
        .catch(() => []);
      result.toolCalls = events.length;
      if (!result.trace.length && events.length)
        result.trace.push({
          step: 0,
          status: "interrupted",
          tools: events.map((e) =>
            redact(String((e.payload as { name?: string }).name ?? "unknown"), secrets),
          ),
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

/** Disable scheduled work before cancelling every actor, including earlier isolated workspaces. */
export async function cleanupActors(
  handles: Pick<EvalApp, "app" | "prisma">,
  actors: readonly { botId: string; cookie: string }[],
): Promise<void> {
  const failures: unknown[] = [];
  try {
    await handles.prisma.routine.updateMany({
      where: { botId: { in: actors.map((actor) => actor.botId) } },
      data: { active: false, nextRunAt: null },
    });
  } catch (error) {
    failures.push(error);
  }
  for (const actor of actors) {
    try {
      await rpc(handles.app, actor.cookie, "threads/stop", { botId: actor.botId });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new Error("Trial work could not be stopped");
}
