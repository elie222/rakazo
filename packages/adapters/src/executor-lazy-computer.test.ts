import type { AgentRunRequest, ComputerRef } from "@rakazo/adapter-kit";
import { SandboxRateLimitError } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { createRunExecutor } from "./executor.js";

const sink = createTestSink();

const provisionComputer = vi.hoisted(() => vi.fn());

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: async () => null,
  acquireDedicatedScreenLeaseFence: async () => null,
  provisionComputer,
}));

const COMPUTER: ComputerRef = {
  id: "sandbox-1",
  botId: "home-1",
  kind: "e2b",
  providerRef: "sandbox-1",
};

/** A routine run whose model makes the given tool calls, then answers. */
async function runRoutine(
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>,
  options: {
    takeover?: boolean;
    native?: boolean;
    nativeUnavailable?: boolean;
    toolFailure?: "abort" | "recover";
    attachments?: "file" | "image";
    steering?: boolean;
    steeringAfterFirst?: boolean;
    copyFailureOnce?: boolean;
    parallel?: boolean;
    priorSetupFailures?: number;
  } = {},
) {
  const attachment: Extract<MessageBlock, { kind: "file" | "image" }> = {
    kind: options.attachments ?? "file",
    artifactId: "artifact-1",
    name: "private-upload.png",
    mimeType: options.attachments === "image" ? "image/png" : "text/plain",
    size: 4,
  };
  const run = {
    id: "run-1",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: "user-1",
    status: "queued",
    trigger: options.attachments && !options.steering ? "user" : "routine",
    sourceMessageId: options.attachments && !options.steering ? "message-1" : null,
    routineId: "routine-1",
    retryOfRunId: null,
    leaseFence: 0,
  };
  const toolResults: unknown[] = [];
  const steeringInputs: unknown[] = [];
  const runtimeRun = vi.fn(async function* (request: AgentRunRequest) {
    if (options.steering && !options.steeringAfterFirst) {
      steeringInputs.push(...((await request.claimSteering?.([])) ?? []));
    }
    const execute = async (call: (typeof toolCalls)[number], index: number) => {
      try {
        toolResults.push(await request.executeTool?.(call.name, call.args, `exec-${index}`));
      } catch (error) {
        if (!options.toolFailure) throw error;
      }
      if (index === 0 && options.steeringAfterFirst) {
        steeringInputs.push(...((await request.claimSteering?.([])) ?? []));
      }
      if (options.toolFailure === "abort") throw new DOMException("Aborted", "AbortError");
    };
    if (options.parallel) await Promise.all(toolCalls.map(execute));
    else for (const [index, call] of toolCalls.entries()) await execute(call, index);
    if (options.takeover) {
      yield { type: "takeover" as const, reason: "Sign in to the inbox." };
      return;
    }
    yield { type: "text-delta" as const, text: "Inbox is clear." };
    yield { type: "done" as const, text: "Inbox is clear." };
  });
  const prisma = {
    run: {
      findUnique: vi.fn(async () => run),
      findUniqueOrThrow: vi.fn(async () => run),
      findFirst: vi.fn(async () => ({
        bot: { notifyOnFinish: false },
        thread: { groupId: null },
      })),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(run, data);
        return { count: 1 };
      }),
    },
    routine: { findUnique: vi.fn(async () => ({ notify: false, nextRunAt: null })) },
    event: { count: vi.fn(async () => 0) },
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
        computer: {
          id: "computer-1",
          scope: "dedicated",
          kind: options.native ? "desktop" : "e2b",
          homeKey: "home-1",
        },
      })),
      findUnique: vi.fn(async () => ({ name: "Assistant" })),
      findMany: vi.fn(async () => []),
    },
    attempt: {
      create: vi.fn(async () => ({ id: "attempt-1" })),
      findMany: vi.fn(async () =>
        Array.from({ length: options.priorSetupFailures ?? 0 }, () => ({
          status: "setup_failed",
          error: "Run setup failed; retrying",
        })),
      ),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    thread: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.threadId,
        groupId: null,
        historyCompactionSummary: null,
        historyCompactedUpToSeq: null,
        nextMessageSeq: 1,
      })),
    },
    message: {
      findMany: vi.fn(async () =>
        options.attachments && !options.steering
          ? [
              {
                id: "message-1",
                role: "user",
                runId: run.id,
                seq: 1,
                blocks: [attachment],
              },
            ]
          : [],
      ),
      findUnique: vi.fn(async () => null),
      findFirst: vi.fn(async () => null),
      count: vi.fn(async () => 0),
    },
    task: { findUniqueOrThrow: vi.fn(async () => ({ id: run.taskId, prompt: "Sweep the inbox" })) },
    computer: { updateMany: vi.fn(async () => ({ count: 1 })) },
    connection: { findMany: vi.fn(async () => []) },
    spaceModelPreference: { findFirst: vi.fn(async () => null) },
    secret: { findFirst: vi.fn(async () => null) },
    userModelCredential: { findFirst: vi.fn(async () => null) },
    spaceBackupModel: { findMany: vi.fn(async () => []) },
    deploymentSettings: {
      findUnique: vi.fn(async () => ({
        defaultModelProvider: "openrouter",
        defaultModelId: "deepseek/deepseek-v4-flash-0731",
      })),
    },
    taughtSkill: { findMany: vi.fn(async () => []) },
    agentSecret: { findMany: vi.fn(async () => []) },
    botSecret: { findMany: vi.fn(async () => []) },
    agentSkill: { findMany: vi.fn(async () => []) },
    scratchpadItem: { findMany: vi.fn(async () => []) },
    externalEffect: { findMany: vi.fn(async () => []) },
    artifact: {
      findMany: vi.fn(async () =>
        options.attachments
          ? [
              {
                id: "artifact-1",
                storageKey: "private-storage-key",
                name: attachment.name,
                mimeType: attachment.mimeType,
                size: 4,
              },
            ]
          : [],
      ),
    },
  };
  const sandbox = {
    describe: () => ({ id: "e2b", capabilities: { graphical: false } }),
    environment: options.native
      ? vi.fn(async () => {
          if (options.nativeUnavailable) throw new Error("native app is closed");
          return { platform: "win32", home: "C:\\Users\\example", shell: "powershell.exe" };
        })
      : undefined,
    listFiles: vi.fn(async () => [{ path: "notes.txt", kind: "file", size: 4 }]),
    writeFile: vi.fn(async () => undefined),
    releaseScreen: vi.fn(async () => undefined),
    async *exportWorkspace() {
      yield* [];
    },
  };
  if (options.copyFailureOnce)
    sandbox.writeFile.mockRejectedValueOnce(new Error("temporary copy failure"));
  const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));
  const enqueue = vi.fn(async () => undefined);
  const executor = createRunExecutor({
    prisma: withEmptyModels(prisma),
    deploymentModelKey: "fake-deployment-key",
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
    sandbox,
    home: { commit: vi.fn(async () => "fixture-revision") },
    memory: { read: async () => ({ documents: [] }) },
    memoryProviders: { resolve: async () => null },
    artifacts: { get: vi.fn(async () => new Uint8Array([1, 2, 3, 4])) },
    events: {
      append: vi.fn(async () => undefined),
      claimSteering: vi.fn(async () => [
        { id: "steering-1", messageId: "message-2", text: "Look at this", blocks: [attachment] },
      ]),
      finalizeRun,
      pauseRunForTakeover: vi.fn(async () => false),
    },
    jobs: { enqueue },
    notifications: { send: vi.fn(async () => undefined) },
    secrets: [],
  } as unknown as Parameters<typeof createRunExecutor>[0]);

  await executor.continueRun(run.id, "worker-1");
  const sleepJobs = enqueue.mock.calls
    .map((call) => (call as unknown[])[0] as { name: string })
    .filter((job) => job.name === "computer.sleep");
  return {
    finalizeRun,
    sandbox,
    sleepJobs,
    toolResults,
    enqueue,
    runtimeRun,
    steeringInputs,
    prisma,
  };
}

beforeEach(() => {
  sink.events.length = 0;
  installLogger(createLogger({ service: "test", sinks: [sink] }));
  provisionComputer.mockReset();
  provisionComputer.mockResolvedValue(COMPUTER);
});

afterEach(() => {
  vi.clearAllMocks();
  installLogger(createLogger({ service: "test", level: "off", sinks: [] }));
});

describe("run computer provisioning", () => {
  it("never starts the computer for a run that does not use it", async () => {
    const { finalizeRun, sandbox, sleepJobs } = await runRoutine([]);

    expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
    expect(provisionComputer).not.toHaveBeenCalled();
    expect(sandbox.releaseScreen).not.toHaveBeenCalled();
    expect(sleepJobs).toEqual([]);
  });

  it.each(["file", "image"] as const)(
    "keeps %s attachments lazy and images available to the model",
    async (attachments) => {
      const { finalizeRun, sandbox, runtimeRun } = await runRoutine([], { attachments });
      expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
      expect(provisionComputer).not.toHaveBeenCalled();
      expect(sandbox.writeFile).not.toHaveBeenCalled();
      if (attachments === "image") {
        expect(runtimeRun.mock.calls[0]?.[0].currentTurnImages).toEqual([
          expect.objectContaining({ mimeType: "image/png", data: new Uint8Array([1, 2, 3, 4]) }),
        ]);
      }
      expect(sink.events).toContainEqual(
        expect.objectContaining({ message: "run.computer", reason: "none", ready: false }),
      );
      expect(JSON.stringify(sink.events)).not.toContain("private-upload");
      expect(JSON.stringify(sink.events)).not.toContain("private-storage-key");
    },
  );

  it.each([false, true])(
    "copies pending attachments before the first tool, including steering: %s",
    async (steering) => {
      const { finalizeRun, sandbox } = await runRoutine(
        [
          { name: "list_files", args: { path: "" } },
          { name: "list_files", args: { path: "" } },
        ],
        { attachments: "file", steering },
      );
      expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
      expect(provisionComputer).toHaveBeenCalledOnce();
      expect(sandbox.writeFile).toHaveBeenCalledOnce();
      expect(sandbox.writeFile.mock.invocationCallOrder[0]).toBeLessThan(
        sandbox.listFiles.mock.invocationCallOrder[0]!,
      );
      expect(sink.events.filter((event) => event.message === "computer.requested")).toEqual([
        expect.objectContaining({ reason: "tool", tool: "list_files" }),
      ]);
    },
  );

  it("shares provisioning and copies attachments once across parallel tools", async () => {
    const { sandbox, finalizeRun } = await runRoutine(
      [
        { name: "list_files", args: { path: "" } },
        { name: "list_files", args: { path: "" } },
      ],
      { attachments: "file", parallel: true },
    );
    expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
    expect(provisionComputer).toHaveBeenCalledOnce();
    expect(sandbox.writeFile).toHaveBeenCalledOnce();
    expect(sandbox.listFiles).toHaveBeenCalledTimes(2);
  });

  it("retries a transient attachment copy before a later tool without reprovisioning", async () => {
    const { sandbox, finalizeRun } = await runRoutine(
      [
        { name: "list_files", args: { path: "" } },
        { name: "list_files", args: { path: "" } },
      ],
      { attachments: "file", copyFailureOnce: true, toolFailure: "recover" },
    );
    expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
    expect(provisionComputer).toHaveBeenCalledOnce();
    expect(sandbox.writeFile).toHaveBeenCalledTimes(2);
    expect(sandbox.listFiles).toHaveBeenCalledOnce();
  });

  it("delivers steering text and inline images without copying onto an already-started computer", async () => {
    const { sandbox, finalizeRun, steeringInputs } = await runRoutine(
      [{ name: "list_files", args: { path: "" } }],
      { attachments: "image", steering: true, steeringAfterFirst: true, copyFailureOnce: true },
    );
    expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
    expect(provisionComputer).toHaveBeenCalledOnce();
    expect(sandbox.writeFile).not.toHaveBeenCalled();
    expect(steeringInputs).toEqual([
      expect.objectContaining({
        historyText: "Look at this",
        images: [
          expect.objectContaining({ mimeType: "image/png", data: new Uint8Array([1, 2, 3, 4]) }),
        ],
      }),
    ]);
  });

  it("copies steering attachments onto an already-started computer before the next tool", async () => {
    const { sandbox, finalizeRun } = await runRoutine(
      [
        { name: "list_files", args: { path: "" } },
        { name: "list_files", args: { path: "" } },
      ],
      { attachments: "file", steering: true, steeringAfterFirst: true },
    );
    expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
    expect(provisionComputer).toHaveBeenCalledOnce();
    expect(sandbox.writeFile).toHaveBeenCalledOnce();
    expect(sandbox.writeFile.mock.invocationCallOrder[0]).toBeGreaterThan(
      sandbox.listFiles.mock.invocationCallOrder[0]!,
    );
    expect(sandbox.writeFile.mock.invocationCallOrder[0]).toBeLessThan(
      sandbox.listFiles.mock.invocationCallOrder[1]!,
    );
  });

  it("does not boot for a steering attachment without computer tools", async () => {
    await runRoutine([], { attachments: "image", steering: true });
    expect(provisionComputer).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "keeps native chat lazy when native access is unavailable: %s",
    async (nativeUnavailable) => {
      const { finalizeRun, sandbox } = await runRoutine([], { native: true, nativeUnavailable });
      expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
      expect(provisionComputer).not.toHaveBeenCalled();
      expect(sandbox.environment).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "desktop", botId: "home-1" }),
        expect.anything(),
      );
    },
  );

  it("starts the computer the first time a tool needs it and reuses it", async () => {
    const { finalizeRun, sandbox, sleepJobs, toolResults } = await runRoutine([
      { name: "list_files", args: { path: "" } },
      { name: "list_files", args: { path: "" } },
    ]);

    expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
    expect(provisionComputer).toHaveBeenCalledOnce();
    expect(provisionComputer).toHaveBeenCalledWith(
      expect.anything(),
      "computer-1",
      expect.objectContaining({ runId: "run-1" }),
      "bot",
    );
    expect(sandbox.listFiles).toHaveBeenCalledTimes(2);
    expect(sandbox.listFiles).toHaveBeenCalledWith(COMPUTER, expect.any(String), expect.anything());
    expect(toolResults[0]).toMatchObject({ entries: [{ path: "notes.txt" }] });
    expect(sleepJobs).toHaveLength(1);
    expect(sandbox.releaseScreen).toHaveBeenCalledWith(COMPUTER, expect.anything());
  });

  it("starts the computer before handing its screen to the user", async () => {
    await runRoutine([], { takeover: true });

    expect(provisionComputer).toHaveBeenCalledOnce();
  });

  it("keeps setup-failure retry semantics when the computer cannot start", async () => {
    provisionComputer.mockRejectedValue(new Error("provider unavailable"));

    await expect(runRoutine([{ name: "list_files", args: { path: "" } }])).rejects.toThrow(
      "Run setup failed; retrying",
    );
    expect(provisionComputer).toHaveBeenCalledOnce();
  });

  it("fails the run instead of retrying once setup has failed too many times in a row", async () => {
    provisionComputer.mockRejectedValue(new Error("provider unavailable"));

    const { finalizeRun, enqueue, prisma } = await runRoutine(
      [{ name: "list_files", args: { path: "" } }],
      { priorSetupFailures: 7 },
    );

    expect(finalizeRun).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ outcome: "failed", error: "provider unavailable" }),
    );
    expect(enqueue).not.toHaveBeenCalled();
    // Busy-computer and database waits between failures neither count nor reset the streak.
    expect(prisma.attempt.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ NOT: { status: "setup_failed", error: null } }),
      }),
    );
  });

  it.each([undefined, "abort", "recover"] as const)(
    "finishes rate-limited runs without retrying when the model handles tool failure as %s",
    async (toolFailure) => {
      const error = new SandboxRateLimitError({ cause: new Error("Provider account limit") });
      provisionComputer.mockRejectedValue(error);

      const { finalizeRun, enqueue } = await runRoutine(
        [{ name: "list_files", args: { path: "" } }],
        { toolFailure },
      );

      expect(provisionComputer).toHaveBeenCalledOnce();
      expect(finalizeRun).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ outcome: "failed", error: error.message }),
      );
      expect(enqueue).not.toHaveBeenCalled();
    },
  );
});

/** Models the run reads but these tests do not care about behave as empty tables. */
function withEmptyModels<T extends object>(prisma: T): T {
  const empty = {
    findMany: async () => [],
    findFirst: async () => null,
    findUnique: async () => null,
    count: async () => 0,
    updateMany: async () => ({ count: 0 }),
  };
  return new Proxy(prisma, {
    get: (target, key) => (key in target ? target[key as keyof T] : empty),
  });
}
