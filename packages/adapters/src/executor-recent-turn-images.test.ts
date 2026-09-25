import type { AgentRunRequest } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { createRunExecutor } from "./executor.js";

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: async () => null,
  provisionComputer: async () => ({ id: "computer-1", kind: "desktop" }),
}));

const TEXT_ONLY_MODEL = "deepseek/deepseek-v4-flash-0731";
const VISION_MODEL = "openai/gpt-4o";

function historyMessages(): Array<{
  id: string;
  threadId: string;
  seq: number;
  role: string;
  runId: string;
  blocks: MessageBlock[];
  replyToMessageId: null;
  replyQuote: null;
  replyTo: null;
}> {
  return [
    {
      id: "current",
      threadId: "thread-1",
      seq: 2,
      role: "user",
      runId: "run-1",
      blocks: [{ kind: "text", text: "what was in the screenshot?" }],
      replyToMessageId: null,
      replyQuote: null,
      replyTo: null,
    },
    {
      id: "earlier",
      threadId: "thread-1",
      seq: 1,
      role: "user",
      runId: "run-0",
      blocks: [{ kind: "image", artifactId: "art-1", mimeType: "image/png", name: "shot.png" }],
      replyToMessageId: null,
      replyQuote: null,
      replyTo: null,
    },
  ];
}

async function runWithModel(modelId: string) {
  const run = {
    id: "run-1",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: "user-1",
    status: "queued",
    trigger: "user",
    leaseFence: 0,
  };
  const get = vi.fn(async () => new Uint8Array([1, 2, 3, 4]));
  let request: AgentRunRequest | undefined;
  const runtimeRun = vi.fn(async function* (next: AgentRunRequest) {
    request = next;
    yield { type: "done" as const, text: "Done" };
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
      findMany: vi.fn(async (args: { where?: { threadId?: string } }) =>
        args.where?.threadId ? historyMessages() : [],
      ),
      findUnique: vi.fn(async () => null),
    },
    task: { findUniqueOrThrow: vi.fn(async () => ({ id: run.taskId, prompt: "Look again" })) },
    connection: { findMany: vi.fn(async () => []) },
    spaceModelPreference: { findFirst: vi.fn(async () => null) },
    userModelCredential: { findFirst: vi.fn(async () => null) },
    deploymentSettings: {
      findUnique: vi.fn(async () => ({
        defaultModelProvider: "openrouter",
        defaultModelId: modelId,
      })),
    },
    taughtSkill: { findMany: vi.fn(async () => []) },
    agentSecret: { findMany: vi.fn(async () => []) },
    agentSkill: { findMany: vi.fn(async () => []) },
    scratchpadItem: { findMany: vi.fn(async () => []) },
    externalEffect: { findMany: vi.fn(async () => []) },
    artifact: {
      findMany: vi.fn(async () => [
        { id: "art-1", storageKey: "shot.png", size: 4, mimeType: "image/png", name: "shot.png" },
      ]),
    },
  };
  const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));
  const executor = createRunExecutor({
    prisma,
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
    sandbox: { describe: () => ({ capabilities: { graphical: false } }) },
    memory: { read: async () => ({ documents: [] }) },
    memoryProviders: { resolve: async () => null },
    artifacts: { get },
    events: { append: vi.fn(async () => undefined), finalizeRun },
    jobs: { enqueue: vi.fn(async () => undefined) },
    secrets: [],
  } as unknown as Parameters<typeof createRunExecutor>[0]);

  await executor.continueRun(run.id, "worker-1");
  expect(runtimeRun).toHaveBeenCalled();
  expect(finalizeRun).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
  if (!request) throw new Error("runtime was not called");
  return { request, get };
}

describe("recent turn images follow model vision", () => {
  it("does not send history images to a text-only model", async () => {
    const { request, get } = await runWithModel(TEXT_ONLY_MODEL);

    expect(request.model.id).toBe(TEXT_ONLY_MODEL);
    expect(request.history.find((entry) => entry.id === "earlier")?.images).toBeUndefined();
    expect(get).not.toHaveBeenCalled();
  });

  it("attaches an earlier turn's image for a model that can see it", async () => {
    const { request, get } = await runWithModel(VISION_MODEL);

    expect(request.model.id).toBe(VISION_MODEL);
    expect(request.history.find((entry) => entry.id === "earlier")?.images?.[0]).toMatchObject({
      name: "shot.png",
      mimeType: "image/png",
    });
    expect(request.history.find((entry) => entry.id === "current")?.images).toBeUndefined();
    expect(get).toHaveBeenCalledWith("shot.png", expect.anything());
  });
});
