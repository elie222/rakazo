import type { AgentRunRequest } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { returnBotMessageOutcome } from "./bot-messages.js";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { createRunExecutor } from "./executor.js";

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: async () => null,
  provisionComputer: async () => ({ id: "computer-1", kind: "desktop" }),
}));

vi.mock("./bot-messages.js", () => ({
  loadBotMessageContext: async () => ({
    fromBotId: "caller",
    fromBotName: "Caller",
    text: "FYI",
    intent: "fyi",
    hop: 1,
    repliesToRequest: false,
  }),
  returnBotMessageOutcome: vi.fn(async () => undefined),
}));

async function runTurn(finalText: string, silent = true) {
  const run = {
    id: "run-1",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: "user-1",
    status: "queued",
    trigger: silent ? "bot_message" : "user",
    sourceMessageId: "source-1",
    leaseFence: 0,
  };
  const narration = "I will check that.";
  const runtimeRun = vi.fn(async function* (_request: AgentRunRequest) {
    yield { type: "text" as const, text: narration };
    yield {
      type: "tool" as const,
      name: "read_file",
      args: {},
      executionId: "call-1",
    };
    if (finalText) yield { type: "text" as const, text: finalText };
    yield { type: "done" as const, text: narration + finalText };
  });
  const prisma = {
    run: {
      findUnique: vi.fn(async () => run),
      findUniqueOrThrow: vi.fn(async () => run),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(run, data);
        return { count: 1 };
      }),
    },
    bot: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.botId,
        name: "Assistant",
        title: "Assistant",
        description: "Test assistant",
        modelProvider: null,
        modelId: null,
        thinkingLevel: null,
        computerId: "computer-1",
        computerSwitching: false,
        memoryScope: null,
        computer: { id: "computer-1", scope: "dedicated" },
      })),
      findMany: vi.fn(async () => []),
    },
    attempt: {
      create: vi.fn(async () => ({ id: "attempt-1" })),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    thread: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.threadId,
        groupId: null,
        historyCompactionSummary: null,
        historyCompactedUpToSeq: null,
        nextMessageSeq: 3,
      })),
    },
    message: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
      findFirst: vi.fn(async () => null),
    },
    task: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.taskId,
        prompt: "Look again",
      })),
    },
    computer: { updateMany: vi.fn(async () => ({ count: 1 })) },
    connection: { findMany: vi.fn(async () => []) },
    spaceModelPreference: {
      findFirst: vi.fn<(...args: unknown[]) => Promise<Record<string, unknown> | null>>(
        async () => null,
      ),
    },
    secret: { findFirst: vi.fn(async () => null) },
    userModelCredential: { findFirst: vi.fn(async () => null) },
    spaceBackupModel: { findMany: vi.fn(async () => []) },
    deploymentSettings: {
      findUnique: vi.fn(async () => ({
        defaultModelProvider: "scripted",
        defaultModelId: "scripted",
      })),
    },
    taughtSkill: { findMany: vi.fn(async () => []) },
    agentSecret: { findMany: vi.fn(async () => []) },
    botSecret: { findMany: vi.fn(async () => []) },
    agentSkill: { findMany: vi.fn(async () => []) },
    scratchpadItem: { findMany: vi.fn(async () => []) },
    externalEffect: { findMany: vi.fn(async () => []) },
    computerExecutionLease: {
      updateManyAndReturn: vi.fn(async () => [{ fence: 1 }]),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    $queryRaw: vi.fn(async () => [{ id: "row-1", scope: "dedicated" }]),
    $transaction: vi.fn(
      async (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => fn(prisma),
    ),
  };
  const finalizeRun = vi.fn(async (_input: { blocks: MessageBlock[] }) => ({
    continuationRunId: null,
  }));
  const executor = createRunExecutor({
    prisma,
    runtime: {
      describe: () => ({ capabilities: { scripted: false } }),
      run: runtimeRun,
    },
    sandbox: {
      describe: () => ({ capabilities: { graphical: false } }),
      writeFile: vi.fn(async () => undefined),
      async *exportWorkspace() {
        yield* [];
      },
    },
    home: { commit: vi.fn(async () => "fixture-revision") },
    memory: { read: async () => ({ documents: [] }) },
    memoryProviders: { resolve: async () => null },
    events: { append: vi.fn(async () => undefined), finalizeRun },
    jobs: { enqueue: vi.fn(async () => undefined) },
    secrets: [],
  } as unknown as Parameters<typeof createRunExecutor>[0]);

  await executor.continueRun(run.id, "worker-1");
  expect(runtimeRun).toHaveBeenCalled();
  expect(finalizeRun).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
  return { finalizeRun };
}

describe("withheld narration on short peer turns", () => {
  it.each(["", "Checked: all clear."])("returns only the post-tool final %j", async (finalText) => {
    vi.mocked(returnBotMessageOutcome).mockClear();
    const { finalizeRun } = await runTurn(finalText);
    expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
    expect(finalizeRun.mock.calls[0]![0].blocks.filter((block) => block.kind === "text")).toEqual(
      finalText ? [{ kind: "text", text: finalText }] : [],
    );
    if (finalText) {
      expect(returnBotMessageOutcome).toHaveBeenCalledExactlyOnceWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        finalText,
        "result",
      );
    } else {
      expect(returnBotMessageOutcome).not.toHaveBeenCalled();
    }
  });
});

describe("withheld narration on short reply-producing turns", () => {
  it.each(["", "Checked: all clear."])("keeps pre-tool text with final %j", async (finalText) => {
    const { finalizeRun } = await runTurn(finalText, false);
    const text = finalizeRun.mock.calls[0]![0].blocks.filter((block) => block.kind === "text")
      .map((block) => block.text)
      .join("");
    expect(text).toBe(`I will check that.${finalText}`);
  });
});
