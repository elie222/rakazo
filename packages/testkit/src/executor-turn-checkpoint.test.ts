import type { AgentRunModel } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type * as ComputerLifecycle from "../../adapters/src/computer-lifecycle.js";
import { createRunExecutor } from "../../adapters/src/executor.js";
import { PiAgentRuntime } from "../../adapters/src/pi-runtime.js";
import { startModelEmulator } from "./model-emulator.js";

vi.mock("../../adapters/src/computer-lifecycle.js", async (original) => ({
  ...(await original<typeof ComputerLifecycle>()),
  acquireComputerExecutionLease: async () => null,
  acquireDedicatedScreenLeaseFence: async () => null,
  holdComputerExecutionLeaseForTakeover: async () => true,
  provisionComputer: async () => ({
    id: "fixture-computer",
    botId: "fixture-bot",
    kind: "fake",
    providerRef: "fixture-computer",
  }),
}));

function fixture(model: AgentRunModel) {
  const run = {
    id: "fixture-run",
    botId: "fixture-bot",
    threadId: "fixture-thread",
    taskId: "fixture-task",
    spaceId: "fixture-space",
    userId: "fixture-owner",
    status: "queued",
    trigger: "routine",
    routineId: null,
    leaseFence: 0,
    checkpoint: null,
  };
  const task = { id: run.taskId, prompt: "Read evidence then complete the fixture." };
  const effects: Record<string, unknown>[] = [];
  const empty = {
    findMany: async () => [],
    findFirst: async () => null,
    findUnique: async () => null,
    count: async () => 0,
    updateMany: async () => ({ count: 0 }),
  };
  const prisma = new Proxy(
    {
      actionApprovalRule: {
        findMany: async () => [
          { effect: "require_approval", matchKind: "tool", matchValue: "fixture_write" },
        ],
      },
      message: {
        ...empty,
        create: async ({ data }: { data: object }) => ({ id: "fixture-message", ...data }),
      },
      event: { ...empty, create: async ({ data }: { data: object }) => ({ seq: 1, ...data }) },
      usageRecord: { createMany: async () => ({ count: 1 }) },
      run: {
        findUnique: async () => ({ ...run }),
        findUniqueOrThrow: async () => ({ ...run }),
        findFirst: async () => null,
        updateMany: async ({ data }: { data: object }) => {
          Object.assign(run, data);
          return { count: 1 };
        },
      },
      task: { findUniqueOrThrow: async () => task, updateMany: async () => ({ count: 1 }) },
      bot: {
        ...empty,
        update: async () => ({}),
        findUniqueOrThrow: async () => ({
          id: run.botId,
          name: "Fixture",
          title: "Fixture",
          description: "Fixture",
          modelProvider: model.provider,
          modelId: model.id,
          computerId: "fixture-computer",
          computerSwitching: false,
          memoryScope: null,
          computer: {
            id: "fixture-computer",
            scope: "dedicated",
            kind: "fake",
            homeKey: "fixture-home",
          },
        }),
      },
      attempt: {
        ...empty,
        create: async () => ({ id: "fixture-attempt" }),
        update: async () => ({}),
        updateMany: async () => ({ count: 1 }),
        count: async () => 2,
      },
      thread: {
        update: async () => ({ nextEventSeq: 1, nextMessageSeq: 1 }),
        findUniqueOrThrow: async () => ({
          id: run.threadId,
          groupId: null,
          nextMessageSeq: 1,
          historyCompactionSummary: null,
          historyCompactedUpToSeq: null,
        }),
      },
      deploymentSettings: {
        findUnique: async () => ({
          defaultModelProvider: model.provider,
          defaultModelId: model.id,
        }),
      },
      userModelCredential: {
        ...empty,
        findMany: async () => [
          {
            id: "fixture-credential",
            provider: model.provider,
            defaultModel: model.id,
            secretId: "fixture-key",
          },
        ],
      },
      secret: {
        ...empty,
        findFirst: async () => ({ id: "fixture-key", ciphertext: "fixture-ciphertext" }),
      },
      $queryRaw: async () => [],
      $transaction: async (action: (tx: unknown) => Promise<unknown>) => action(prisma),
      externalEffect: {
        ...empty,
        findMany: async ({ where }: { where: Record<string, unknown> }) =>
          effects.filter((effect) =>
            Object.entries(where).every(
              ([key, value]) => typeof value === "object" || effect[key] === value,
            ),
          ),
        findUnique: async ({ where }: { where: { idempotencyKey: string } }) =>
          effects.find((effect) => effect.idempotencyKey === where.idempotencyKey) ?? null,
        create: async ({ data }: { data: object }) => {
          const effect = { id: `fixture-effect-${effects.length}`, ...data };
          effects.push(effect);
          return effect;
        },
        updateMany: async ({ where, data }: { where: Record<string, unknown>; data: object }) => {
          const matching = effects.filter((effect) =>
            Object.entries(where).every(
              ([key, value]) => typeof value === "object" || effect[key] === value,
            ),
          );
          for (const effect of matching) Object.assign(effect, data);
          return { count: matching.length };
        },
        upsert: async ({
          where,
          create,
          update,
        }: {
          where: { idempotencyKey: string };
          create: object;
          update: object;
        }) => {
          const previous = effects.find((effect) => effect.idempotencyKey === where.idempotencyKey);
          if (previous) {
            Object.assign(previous, update);
            return previous;
          }
          const effect = { id: `fixture-effect-${effects.length}`, ...create };
          effects.push(effect);
          return effect;
        },
        deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
          for (let i = effects.length - 1; i >= 0; i--)
            if (
              Object.entries(where).every(
                ([key, value]) => typeof value === "object" || effects[i]![key] === value,
              )
            )
              effects.splice(i, 1);
          return { count: 1 };
        },
      },
    },
    {
      get(target, key) {
        return key in target ? target[key as keyof typeof target] : empty;
      },
    },
  );
  const finalizeRun = vi.fn(async (input) => {
    run.status = input.outcome;
    await prisma.externalEffect.deleteMany({
      where: { runId: run.id, kind: "runtime_checkpoint" },
    });
    return { continuationRunId: null };
  });
  const pauseRunForInput = vi.fn(async () => {
    run.status = "waiting_input";
    return { continuationRunId: null };
  });
  const pauseRunForTakeover = vi.fn(async () => {
    run.status = "waiting_takeover";
    return { continuationRunId: null };
  });
  const writes = vi.fn(async () => ({ ok: true }));
  const executor = createRunExecutor({
    prisma,
    runtime: new PiAgentRuntime(),
    mcpAllowPrivateEndpoint: true,
    deploymentModelKey: "fixture-key",
    secretStore: {
      load: async () =>
        JSON.stringify({
          kind: "openai_compatible",
          apiKey: "local",
          baseUrl: model.baseUrl,
          allowPrivateEndpoint: true,
          contextWindow: 160000,
          maxTokens: 1024,
        }),
    },
    connector: {
      discoverTools: async () => [
        {
          name: "fixture_write",
          description: "Write the fixture",
          inputSchema: {
            type: "object",
            properties: { content: { type: "string" } },
            required: ["content"],
          },
        },
      ],
      async *execute(call: { args: Record<string, unknown> }) {
        writes(call.args);
        yield { type: "result", data: { ok: true, result: "fixture-approved-result" } };
      },
    },
    sandbox: {
      describe: () => ({ id: "fake", capabilities: { graphical: true } }),
      readFile: async () => new TextEncoder().encode("unique-executor-evidence"),
      writeFile: writes,
      async *exportWorkspace() {},
      releaseScreen: async () => undefined,
    },
    home: { commit: async () => "fixture-revision" },
    memory: { read: async () => ({ documents: [] }) },
    memoryProviders: { resolve: async () => null },
    events: {
      notify: vi.fn(async () => undefined),
      append: vi.fn(async () => undefined),
      claimSteering: async () => [],
      finalizeRun,
      pauseRunForInput,
      pauseRunForTakeover,
    },
    jobs: { enqueue: vi.fn(async () => undefined) },
    notifications: { send: vi.fn(async () => undefined) },
    secrets: [],
  } as unknown as Parameters<typeof createRunExecutor>[0]);
  return {
    executor,
    run,
    task,
    effects,
    finalizeRun,
    pauseRunForInput,
    pauseRunForTakeover,
    writes,
  };
}

describe("executor paused transcript", () => {
  it.each(["ask_user", "approval", "request_takeover"])(
    "restores %s through the real executor before opening the model",
    async (pause) => {
      const name = pause === "approval" ? "fixture_write" : pause;
      const args =
        pause === "approval"
          ? { content: "exact-approved-content" }
          : pause === "request_takeover"
            ? { reason: "Complete the fixture step" }
            : { question: "Which fixture?", options: ["One", "Two"] };
      const model = await startModelEmulator({
        steps: [
          {
            expect() {},
            response: {
              type: "tool",
              id: "evidence",
              name: "read_file",
              arguments: { path: "fixture.txt" },
            },
          },
          {
            expect(request) {
              expect(request.tools?.map((tool) => tool.function.name)).toContain(name);
            },
            response: { type: "tool", id: "pending", name, arguments: args },
          },
          {
            expect(request) {
              const evidence = request.messages.find(
                (message) => message.role === "tool" && message.tool_call_id === "evidence",
              );
              expect(JSON.stringify(evidence)).toContain("unique-executor-evidence");
              const result = request.messages.find(
                (message) => message.role === "tool" && message.tool_call_id === "pending",
              );
              expect(result).toBeDefined();
              if (pause === "approval")
                expect(JSON.stringify(result)).toContain("fixture-approved-result");
              if (pause === "ask_user") expect(JSON.stringify(result)).toContain("Two");
            },
            response: { type: "text", text: "Done." },
          },
        ],
      });
      try {
        const state = fixture(model.model);
        await state.executor.continueRun(state.run.id, "fixture-worker");
        expect(
          pause === "request_takeover" ? state.pauseRunForTakeover : state.pauseRunForInput,
          JSON.stringify(state.finalizeRun.mock.calls),
        ).toHaveBeenCalledOnce();
        expect(state.effects.some((effect) => effect.kind === "runtime_checkpoint")).toBe(true);
        for (const effect of state.effects)
          if (effect.status === "intended") effect.status = "approved";
        state.run.status = "queued";
        if (pause === "request_takeover") state.run.checkpoint = "takeover" as never;
        state.task.prompt = "Two";
        await state.executor.continueRun(state.run.id, "fixture-worker");
        model.assertComplete();
        expect(model.requests).toHaveLength(3);
        expect(state.finalizeRun).toHaveBeenCalledWith(
          expect.objectContaining({ outcome: "completed" }),
        );
        expect(
          pause === "request_takeover" ? state.pauseRunForTakeover : state.pauseRunForInput,
          JSON.stringify(state.finalizeRun.mock.calls),
        ).toHaveBeenCalledOnce();
        expect(state.effects.some((effect) => effect.kind === "runtime_checkpoint")).toBe(false);
        if (pause === "approval") {
          expect(state.writes).toHaveBeenCalledOnce();
          expect(state.writes.mock.calls[0]).toEqual([{ content: "exact-approved-content" }]);
        }
      } finally {
        await model.close();
      }
    },
  );
});
