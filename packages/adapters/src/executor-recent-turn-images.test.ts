import type { AgentRunRequest } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { createRunExecutor } from "./executor.js";

const lifecycleMocks = vi.hoisted(() => ({
  renewComputerExecutionLease: vi.fn(async () => true),
}));

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: async () => null,
  acquireDedicatedScreenLeaseFence: async (
    _prisma: unknown,
    input: { computerId: string; botId: string; runId: string },
  ) => ({
    computerId: input.computerId,
    botId: input.botId,
    runId: input.runId,
    fence: 7,
  }),
  provisionComputer: async () => ({ id: "computer-1", kind: "desktop" }),
  renewComputerExecutionLease: lifecycleMocks.renewComputerExecutionLease,
}));

const TEXT_ONLY_MODEL = "deepseek/deepseek-v4-flash-0731";
const VISION_MODEL = "openai/gpt-4o";

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
type Gate = { reached: Deferred<void>; release: Deferred<void> };
type RunHooks = {
  runtimeGate?: Gate;
  notificationGate?: Gate;
  computerLeaseRenewal?: () => Promise<boolean>;
  /** The model lists the computer's files before answering, which starts the computer. */
  useComputer?: boolean;
  trigger?: string;
  /** A reply bound to this run as steering, claimed before any tool runs. */
  steeringBlocks?: MessageBlock[];
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

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

async function runWithModel(
  modelId: string,
  switchModel?: { provider: string; modelId: string; credentialId?: string },
  backupReadFails = false,
  scripted = false,
  finalizeSuccessfully = true,
  hooks?: RunHooks,
) {
  lifecycleMocks.renewComputerExecutionLease.mockReset();
  lifecycleMocks.renewComputerExecutionLease.mockImplementation(
    hooks?.computerLeaseRenewal ?? (async () => true),
  );
  const run = {
    id: "run-1",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: "user-1",
    status: "queued",
    trigger: hooks?.trigger ?? "user",
    leaseFence: 0,
  };
  const get = vi.fn(async () => new Uint8Array([1, 2, 3, 4]));
  const writeFile = vi.fn(async (..._args: unknown[]) => undefined);
  const exportWorkspace = vi.fn(async function* () {
    yield* [];
  });
  const releaseScreen = vi.fn(async (..._args: unknown[]) => undefined);
  let request: AgentRunRequest | undefined;
  let steering: Awaited<ReturnType<NonNullable<AgentRunRequest["claimSteering"]>>> = [];
  const runtimeRun = vi.fn(async function* (next: AgentRunRequest) {
    request = next;
    if (hooks?.runtimeGate) {
      hooks.runtimeGate.reached.resolve(undefined);
      await hooks.runtimeGate.release.promise;
    }
    if (switchModel) {
      const onModelChange = (
        next as AgentRunRequest & {
          onModelChange?: (provider: string, modelId: string) => Promise<void>;
        }
      ).onModelChange;
      await onModelChange?.(switchModel.provider, switchModel.modelId);
    }
    if (hooks?.steeringBlocks) steering = (await next.claimSteering?.([])) ?? [];
    if (hooks?.useComputer) {
      const executeTool = (
        next as AgentRunRequest & {
          executeTool?: (name: string, args: Record<string, unknown>, id: string) => unknown;
        }
      ).executeTool;
      await executeTool?.("list_files", { path: "" }, "list-1");
    }
    yield { type: "done" as const, text: "Done" };
  });
  const prisma = {
    user: { findUnique: vi.fn(async () => null) },
    run: {
      findUnique: vi.fn(async () => run),
      findUniqueOrThrow: vi.fn(async () => run),
      findFirst: vi.fn(async () => ({ bot: { notifyOnFinish: true }, thread: { groupId: null } })),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(run, data);
        return { count: 1 };
      }),
    },
    chatGroup: { findMany: vi.fn(async () => []) },
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
      // A claimed steering reply looks up the message it quotes; this one quotes nothing.
      findFirst: vi.fn(async () => null),
    },
    task: { findUniqueOrThrow: vi.fn(async () => ({ id: run.taskId, prompt: "Look again" })) },
    computer: {
      updateMany: vi.fn(async () => ({ count: 1 })),
      findFirst: vi.fn(async () => ({
        state: "running",
        restorePending: false,
        screenGeneration: 0,
      })),
    },
    connection: { findMany: vi.fn(async () => []) },
    userModelPreference: {
      findFirst: vi.fn<(...args: unknown[]) => Promise<Record<string, unknown> | null>>(
        async () => null,
      ),
    },
    secret: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
    userModelCredential: { findFirst: vi.fn(async () => null) },
    userModelRoleChoice: {
      findMany: vi.fn(async ({ where }: { where: { role: string } }) => {
        if (where.role !== "main") return [];
        // The run reads its main model first and its fallbacks just before the model call.
        if (backupReadFails && prisma.userModelRoleChoice.findMany.mock.calls.length > 1)
          throw new Error("Backup list unavailable");
        return switchModel ? [{ ...switchModel, position: 1, thinkingLevel: null }] : [];
      }),
    },

    deploymentSettings: {
      findUnique: vi.fn(async () => ({
        defaultModelProvider: "openrouter",
        defaultModelId: modelId,
      })),
    },
    taughtSkill: { findMany: vi.fn(async () => []) },
    vaultCredential: { findMany: vi.fn(async () => []) },
    agentSkill: { findMany: vi.fn(async () => []) },
    scratchpadItem: { findMany: vi.fn(async () => []) },
    externalEffect: { findMany: vi.fn(async () => []) },
    spaceSettingOverride: { findUnique: async () => null },
    userActionApprovalRule: { findMany: vi.fn(async () => []) },
    userActionAutoReviewPreference: { findUnique: vi.fn(async () => null) },
    artifact: {
      findMany: vi.fn(async () => [
        { id: "art-1", storageKey: "shot.png", size: 4, mimeType: "image/png", name: "shot.png" },
        { id: "art-2", storageKey: "reply.png", size: 4, mimeType: "image/png", name: "reply.png" },
      ]),
    },
  };
  const finalizeRun = vi.fn(async () =>
    finalizeSuccessfully ? { continuationRunId: null } : null,
  );
  const notificationSend = vi.fn(async () => {
    if (!hooks?.notificationGate) return;
    hooks.notificationGate.reached.resolve(undefined);
    await hooks.notificationGate.release.promise;
  });
  const executor = createRunExecutor({
    prisma,
    deploymentModelKey: "fake-deployment-key",
    runtime: { describe: () => ({ capabilities: { scripted } }), run: runtimeRun },
    sandbox: {
      describe: () => ({ capabilities: { graphical: false } }),
      releaseScreen,
      writeFile,
      listFiles: vi.fn(async () => []),
      readFile: vi.fn().mockRejectedValue(new Error("missing")),
      exportWorkspace,
    },
    home: { commit: vi.fn(async () => "fixture-revision") },
    memory: { read: async () => ({ documents: [] }) },
    memoryProviders: { resolve: async () => null },
    artifacts: { get },
    events: {
      append: vi.fn(async () => undefined),
      finalizeRun,
      claimSteering: vi.fn(async ({ seenIds }: { seenIds: string[] }) =>
        hooks?.steeringBlocks && !seenIds.includes("reply-steering")
          ? [
              {
                id: "reply-steering",
                messageId: "reply",
                text: "Here it is",
                blocks: hooks.steeringBlocks,
              },
            ]
          : [],
      ),
    },
    jobs: { enqueue: vi.fn(async () => undefined) },
    notifications: hooks?.notificationGate ? { send: notificationSend } : undefined,
    secrets: [],
  } as unknown as Parameters<typeof createRunExecutor>[0]);

  const execution = executor.continueRun(run.id, "worker-1");
  if (hooks?.runtimeGate) await hooks.runtimeGate.reached.promise;
  else if (hooks?.notificationGate) await hooks.notificationGate.reached.promise;
  else await execution;
  expect(runtimeRun).toHaveBeenCalled();
  expect(finalizeRun).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
  if (!request) throw new Error("runtime was not called");
  return {
    request,
    steering,
    get,
    writeFile,
    exportWorkspace,
    prisma,
    run,
    releaseScreen,
    execution,
    notificationSend,
  };
}

describe("recent turn images follow model vision", () => {
  it("does not send history images to a text-only model", async () => {
    const { request } = await runWithModel(TEXT_ONLY_MODEL);

    expect(request.model.id).toBe(TEXT_ONLY_MODEL);
    expect(request.history.find((entry) => entry.id === "earlier")?.images).toBeUndefined();
  });

  it("lists an earlier turn's image without starting the computer for it", async () => {
    const { request, writeFile, releaseScreen } = await runWithModel(TEXT_ONLY_MODEL);

    expect(writeFile).not.toHaveBeenCalled();
    expect(releaseScreen).not.toHaveBeenCalled();
    expect(request.prompt).toContain(
      'Files attached earlier in this conversation are also on your computer:\n- "shot.png" (image/png, 4 bytes): "attachments/art-1.png"',
    );
  });

  it("puts an earlier turn's image on the computer once the bot uses it", async () => {
    const { request, writeFile, exportWorkspace } = await runWithModel(
      TEXT_ONLY_MODEL,
      undefined,
      false,
      false,
      true,
      { useComputer: true },
    );

    expect(writeFile.mock.calls.map(([, file]) => file)).toEqual([
      { path: "attachments/art-1.png", content: new Uint8Array([1, 2, 3, 4]) },
    ]);
    expect(request.prompt).toContain(
      'Files attached earlier in this conversation are also on your computer:\n- "shot.png" (image/png, 4 bytes): "attachments/art-1.png"',
    );
    expect(exportWorkspace).not.toHaveBeenCalled();
  });

  it("lists and copies a file reply bound to a resumed routine", async () => {
    // "Send as file" stores the picture as a file block; a routine reads no thread history.
    const { request, steering, writeFile } = await runWithModel(
      TEXT_ONLY_MODEL,
      undefined,
      false,
      false,
      true,
      {
        useComputer: true,
        trigger: "routine",
        steeringBlocks: [
          { kind: "text", text: "Here it is" },
          { kind: "file", artifactId: "art-2", name: "reply.png", mimeType: "image/png", size: 4 },
        ],
      },
    );

    expect(request.currentRunRequiresImageInput).toBeFalsy();
    expect(steering).toHaveLength(1);
    expect(steering[0]?.text).toContain('"attachments/art-2.png"');
    expect(steering[0]?.images).toBeUndefined();
    expect(writeFile.mock.calls.map(([, file]) => file)).toContainEqual({
      path: "attachments/art-2.png",
      content: new Uint8Array([1, 2, 3, 4]),
    });
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

  it("continues with no backups when the indexed lookup fails", async () => {
    const { prisma, request } = await runWithModel(TEXT_ONLY_MODEL, undefined, true);
    expect(request.fallbackModels).toEqual([]);
    expect(request.resolveFallbackModel).toBeUndefined();
    expect(prisma.userModelRoleChoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-1", role: "main" } }),
    );
  });

  it("does not read or configure backups for scripted runs", async () => {
    const { prisma, request } = await runWithModel(TEXT_ONLY_MODEL, undefined, false, true);
    // Only the main model itself is read.
    expect(prisma.userModelRoleChoice.findMany).toHaveBeenCalledTimes(1);
    expect(request.fallbackModels).toEqual([]);
    expect(request.resolveFallbackModel).toBeUndefined();
  });

  it("does not recover a backup's missing secret with a deployment key", async () => {
    const backup = { provider: "openrouter", modelId: "openai/gpt-4o" };
    const { prisma, request } = await runWithModel(TEXT_ONLY_MODEL, backup);
    expect(request.model.apiKey).toBe("fake-deployment-key");
    const resolve = request.resolveFallbackModel;
    if (!resolve) throw new Error("Backup resolver is missing");
    prisma.userModelPreference.findFirst.mockResolvedValue({
      modelId: backup.modelId,
      thinkingLevel: null,
      credential: {
        id: "backup-credential",
        userId: "user-1",
        provider: backup.provider,
        label: "Backup",
        secretId: "missing-secret",
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
    });
    vi.stubEnv("OPENROUTER_API_KEY", "fake-deployment-key");
    try {
      await expect(resolve(backup.provider, backup.modelId)).rejects.toThrow(
        "Backup model credential is no longer available",
      );
      expect(prisma.userModelPreference.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            userId: "user-1",
            modelId: backup.modelId,
            credential: { provider: backup.provider },
          },
        }),
      );
      expect(prisma.secret.findFirst).toHaveBeenCalledExactlyOnceWith({
        where: { id: "missing-secret", userId: "user-1", spaceId: null },
      });
      await expect(resolve("openai", "gpt-4o")).rejects.toThrow("Backup model is not selected");
      expect(prisma.secret.findFirst).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("resolves a backup pinned to a connection on that connection only", async () => {
    const backup = {
      provider: "openrouter",
      modelId: "openai/gpt-4o",
      credentialId: "work-credential",
    };
    const { prisma, request } = await runWithModel(TEXT_ONLY_MODEL, backup);
    expect(request.fallbackModels).toEqual([
      { provider: backup.provider, id: backup.modelId, connectionId: "work-credential" },
    ]);
    const resolve = request.resolveFallbackModel;
    if (!resolve) throw new Error("Backup resolver is missing");
    prisma.userModelCredential.findFirst.mockResolvedValue({
      id: "work-credential",
      userId: "user-1",
      provider: backup.provider,
      label: "Work",
      secretId: "work-secret",
      createdAt: new Date(0),
      updatedAt: new Date(0),
      userPreferences: [],
    } as never);
    prisma.userModelPreference.findFirst.mockClear();
    // The same model without its connection is not a configured backup.
    await expect(resolve(backup.provider, backup.modelId)).rejects.toThrow(
      "Backup model is not selected",
    );
    await expect(resolve(backup.provider, backup.modelId, "work-credential")).rejects.toThrow(
      "Backup model credential is no longer available",
    );
    expect(prisma.userModelCredential.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "work-credential", userId: "user-1", provider: backup.provider },
      }),
    );
    expect(prisma.userModelPreference.findFirst).not.toHaveBeenCalled();
    expect(prisma.secret.findFirst).toHaveBeenCalledWith({
      where: { id: "work-secret", userId: "user-1", spaceId: null },
    });
  });

  it("persists the switched model against the current run lease", async () => {
    const backup = { provider: "openrouter", modelId: "openai/gpt-4o" };
    const { prisma, request, run } = await runWithModel(TEXT_ONLY_MODEL, backup);

    expect(request?.model.id).toBe(TEXT_ONLY_MODEL);
    expect(run).toMatchObject({ modelProvider: backup.provider, modelId: backup.modelId });
    expect(prisma.run.updateMany).toHaveBeenCalledWith({
      where: {
        id: "run-1",
        status: "running",
        leaseOwner: "worker-1",
        leaseFence: expect.any(Number),
      },
      data: { modelProvider: backup.provider, modelId: backup.modelId },
    });
  });
});

describe("screen lifecycle after run completion", () => {
  it("keeps only a successfully finalized run's screen warm and uses a dedicated screen fence", async () => {
    const completed = await runWithModel(VISION_MODEL, undefined, false, false, true, {
      useComputer: true,
    });
    expect(completed.releaseScreen).toHaveBeenCalledOnce();
    expect(completed.releaseScreen.mock.calls[0]?.[1]).toMatchObject({
      keepScreenWarm: true,
      screenLeaseId: "run-1:7",
    });

    const unfinished = await runWithModel(VISION_MODEL, undefined, false, false, false, {
      useComputer: true,
    });
    expect(unfinished.releaseScreen).toHaveBeenCalledOnce();
    expect(unfinished.releaseScreen.mock.calls[0]?.[1]).not.toHaveProperty("keepScreenWarm");
    expect(unfinished.releaseScreen.mock.calls[0]?.[1]).toMatchObject({ screenLeaseId: "run-1:7" });
  });

  it("ignores in-flight lease renewal after successful completion", async () => {
    vi.useFakeTimers();
    const runtimeGate = { reached: deferred<void>(), release: deferred<void>() };
    const notificationGate = { reached: deferred<void>(), release: deferred<void>() };
    const renewalStarted = deferred<void>();
    const renewalResult = deferred<boolean>();
    let completed: Awaited<ReturnType<typeof runWithModel>> | undefined;

    try {
      completed = await runWithModel(VISION_MODEL, undefined, false, false, true, {
        runtimeGate,
        notificationGate,
        useComputer: true,
        computerLeaseRenewal: () => {
          renewalStarted.resolve(undefined);
          return renewalResult.promise;
        },
      });

      await vi.advanceTimersByTimeAsync(60_000);
      await renewalStarted.promise;
      expect(lifecycleMocks.renewComputerExecutionLease).toHaveBeenCalledOnce();

      runtimeGate.release.resolve(undefined);
      await notificationGate.reached.promise;
      await vi.advanceTimersByTimeAsync(120_000);

      renewalResult.resolve(false);
      await vi.advanceTimersByTimeAsync(0);
      notificationGate.release.resolve(undefined);
      await completed.execution;

      const releaseContext = completed.releaseScreen.mock.calls[0]?.[1] as {
        keepScreenWarm?: boolean;
        signal: AbortSignal;
      };
      expect({
        renewals: lifecycleMocks.renewComputerExecutionLease.mock.calls.length,
        signalAborted: releaseContext.signal.aborted,
        keepScreenWarm: releaseContext.keepScreenWarm,
      }).toEqual({ renewals: 1, signalAborted: false, keepScreenWarm: true });
    } finally {
      runtimeGate.release.resolve(undefined);
      renewalResult.resolve(false);
      notificationGate.release.resolve(undefined);
      if (completed) await completed.execution;
      vi.useRealTimers();
    }
  });
});
