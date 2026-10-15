import { createHash } from "node:crypto";
import type { AgentRunRequest, AgentRuntimeEvent, ArtifactStore } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { EXECUTION_HARNESS_VERSIONS } from "@rakazo/contracts";
import { toolEffectIdempotencyKey } from "@rakazo/core/node/approval-effect-key";
import type * as DbModule from "@rakazo/db";
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import type * as ComputerWorkspaceModule from "./computer-workspace.js";
import { createRunExecutor } from "./executor.js";
import type * as RemoteMcpModule from "./remote-mcp.js";

const mocks = vi.hoisted(() => ({
  acquire: vi.fn(async () => null),
  binding: vi.fn(),
  handover: vi.fn(),
  claim: vi.fn(),
  checkpoint: vi.fn(),
  nativeRun: vi.fn(),
  factory: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@rakazo/logging", () => ({
  getLogger: () => ({ error: mocks.error, warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));
vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof DbModule>()),
  resolveRunExecutionProfile: mocks.binding,
  resolveExecutionHandover: mocks.handover,
  claimNativeHarnessSession: mocks.claim,
  updateNativeHarnessSession: mocks.checkpoint,
}));
vi.mock("./primary-harness-runtime.js", () => ({ createPrimaryHarnessRuntime: mocks.factory }));
vi.mock("./computer-lifecycle.js", async (original) => ({
  ...(await original<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: mocks.acquire,
  releaseComputerExecutionLease: vi.fn(async () => undefined),
  provisionComputer: vi.fn(async () => ({ id: "computer-A", kind: "docker", botId: "bot-A" })),
}));
vi.mock("./computer-workspace.js", async (original) => ({
  ...(await original<typeof ComputerWorkspaceModule>()),
  checkpointRunComputerWorkspace: vi.fn(async () => undefined),
}));
vi.mock("./remote-mcp.js", async (original) => ({
  ...(await original<typeof RemoteMcpModule>()),
  assertSafeRemoteUrl: vi.fn(async () => undefined),
}));

type Effect = {
  id: string;
  runId: string;
  spaceId: string;
  kind: string;
  idempotencyKey: string;
  status: string;
  request: unknown;
  result?: unknown;
};
function fixture(enabled = true, effects: Effect[] = []) {
  const run = {
    id: "run-A",
    botId: "bot-A",
    threadId: "thread-A",
    taskId: "task-A",
    userId: "user-A",
    spaceId: "space-A",
    status: "queued",
    trigger: "user",
    routineId: null,
    sourceMessageId: null,
    checkpoint: null,
    leaseFence: 0,
    executionProfileSnapshot: { profileId: "profile-A" },
  };
  const row = () => ({
    findMany: vi.fn(async (_args?: unknown): Promise<unknown[]> => []),
    findFirst: vi.fn(async (): Promise<unknown> => null),
    findUnique: vi.fn(async (): Promise<unknown> => null),
    findUniqueOrThrow: vi.fn(async (_args?: unknown): Promise<unknown> => ({})),
    update: vi.fn(async () => ({})),
    updateMany: vi.fn(async (_args?: unknown) => ({ count: 1 })),
    count: vi.fn(async () => 0),
  });
  const models: Record<string, ReturnType<typeof row>> = {};
  const prisma = new Proxy(models, { get: (target, key: string) => (target[key] ??= row()) });
  prisma.run = {
    ...row(),
    updateMany: vi.fn(async (args?: unknown) => {
      Object.assign(run, (args as { data: Record<string, unknown> }).data);
      return { count: 1 };
    }),
    findUnique: vi.fn(async () => run),
    findUniqueOrThrow: vi.fn(async () => ({ ...run, status: "leased", startedAt: null })),
  };
  prisma.bot = {
    ...row(),
    findUniqueOrThrow: vi.fn(async (args?: unknown) =>
      (args as { select?: { computerId?: boolean } })?.select?.computerId
        ? { computerId: "computer-A", computerSwitching: false }
        : {
            id: "bot-A",
            name: "Builder",
            description: "",
            title: "",
            instructions: "",
            computerId: "computer-A",
            memoryScope: "isolated",
            computer: { id: "computer-A", scope: "dedicated" },
            disabledBuiltinTools: [],
          },
    ),
  };
  prisma.attempt = { ...row(), create: vi.fn(async () => ({ id: "attempt-A" })) } as ReturnType<
    typeof row
  >;
  prisma.thread = {
    ...row(),
    findUniqueOrThrow: vi.fn(async () => ({
      id: "thread-A",
      groupId: null,
      historyCompactionSummary: null,
      historyCompactedUpToSeq: null,
      historyCompactionGeneration: 0,
      nextMessageSeq: 1,
    })),
  };
  prisma.task = {
    ...row(),
    findUniqueOrThrow: vi.fn(async () => ({ id: "task-A", prompt: "Answer briefly" })),
  };
  prisma.secret = {
    ...row(),
    findFirst: vi.fn(async () => ({ id: "secret-A", ciphertext: "fake-ciphertext" })),
  };
  prisma.externalEffect = {
    ...row(),
    findMany: vi.fn(async (args?: unknown) => {
      const where = (args as { where?: { status?: string; runId?: string } })?.where;
      return effects.filter(
        (effect) =>
          (!where?.status || effect.status === where.status) &&
          (!where?.runId || effect.runId === where.runId),
      );
    }),
    findUnique: vi.fn(async (args?: unknown) => {
      const where = (args as { where: { idempotencyKey: string } }).where;
      return effects.find((effect) => effect.idempotencyKey === where.idempotencyKey) ?? null;
    }),
    create: vi.fn(async ({ data }: { data: Omit<Effect, "id"> }) => {
      const effect = { ...data, id: `effect-${effects.length}` };
      effects.push(effect);
      return effect;
    }),
    updateMany: vi.fn(async (args?: unknown) => {
      const { where, data } = args as {
        where: { id: string; status?: string };
        data: Partial<Effect>;
      };
      const effect = effects.find(
        (row) => row.id === where.id && (!where.status || row.status === where.status),
      );
      if (!effect) return { count: 0 };
      Object.assign(effect, data);
      return { count: 1 };
    }),
    update: vi.fn(async (args?: unknown) => {
      const { where, data } = args as { where: { id: string }; data: Partial<Effect> };
      const effect = effects.find((row) => row.id === where.id)!;
      Object.assign(effect, data);
      return effect;
    }),
  } as ReturnType<typeof row>;
  const memoryCommit = vi.fn(async () => ({ revision: "revision" }));
  const piRun = vi.fn();
  const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));
  const pauseRunForInput = vi.fn(async () => true);
  const deps = {
    prisma,
    primaryHarnessesEnabled: enabled,
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: piRun },
    memoryProviders: { resolve: vi.fn(async () => null) },
    memory: { read: vi.fn(async () => ({ documents: [] })), commit: memoryCommit },
    events: { append: vi.fn(async () => undefined), finalizeRun, pauseRunForInput },
    jobs: { enqueue: vi.fn(async () => undefined) },
    secrets: [],
    secretStore: { load: vi.fn(async () => "fake-profile-key") },
    sandbox: {
      describe: () => ({ capabilities: { graphical: false } }),
      nativeStateInstallationId: () => "a".repeat(32),
    },
    browser: { describe: () => ({ capabilities: { page: false } }) },
  } as unknown as Parameters<typeof createRunExecutor>[0];
  return {
    executor: createRunExecutor(deps),
    deps,
    piRun,
    finalizeRun,
    pauseRunForInput,
    memoryCommit,
    run,
    prisma,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.handover.mockResolvedValue(null);
  mocks.binding.mockResolvedValue({
    profile: {
      id: "profile-A",
      harness: "claude",
      revision: 1,
      runtimeVersion: EXECUTION_HARNESS_VERSIONS.claude,
      provider: "provider-A",
      modelId: "model-A",
      inputModalities: [],
      protocol: "anthropic",
      endpoint: "https://model.example.test",
      credentialId: "account-A",
      computerId: null,
    },
    credential: { id: "account-A", userId: "user-A", secretId: "secret-A", provider: "provider-A" },
    snapshot: { computerId: "computer-A" },
  });
  mocks.claim.mockResolvedValue({ id: "session-A", epoch: "epoch-A", nativeSessionId: null });
  mocks.checkpoint.mockResolvedValue(undefined);
  mocks.nativeRun.mockImplementation(async function* (
    _request: AgentRunRequest,
  ): AsyncIterable<AgentRuntimeEvent> {
    yield { type: "text", text: "Direct native answer." };
    yield { type: "done" };
  });
  mocks.factory.mockReturnValue({ run: mocks.nativeRun });
});

async function attachedMedia(kind: "image" | "audio") {
  const result = fixture();
  const bytes =
    kind === "image"
      ? await sharp({ create: { width: 2, height: 2, channels: 3, background: "white" } })
          .png()
          .toBuffer()
      : (() => {
          const data = Buffer.alloc(46);
          data.write("RIFF");
          data.writeUInt32LE(38, 4);
          data.write("WAVEfmt ", 8);
          data.writeUInt32LE(16, 16);
          data.writeUInt16LE(1, 20);
          data.writeUInt16LE(1, 22);
          data.writeUInt32LE(16000, 24);
          data.writeUInt32LE(32000, 28);
          data.writeUInt16LE(2, 32);
          data.writeUInt16LE(16, 34);
          data.write("data", 36);
          data.writeUInt32LE(2, 40);
          return data;
        })();
  const mimeType = kind === "image" ? "image/png" : "audio/wav";
  const row = {
    id: "artifact-A",
    name: kind === "image" ? "original.png" : "original.wav",
    spaceId: "space-A",
    userId: "user-A",
    mimeType,
    size: bytes.length,
    hash: createHash("sha256").update(bytes).digest("hex"),
    storageKey: "stored-A",
  };
  const block: MessageBlock =
    kind === "image"
      ? { kind: "image", artifactId: row.id, name: row.name, mimeType }
      : { kind: "file", artifactId: row.id, name: row.name, mimeType, size: row.size };
  const message = {
    id: "message-A",
    threadId: "thread-A",
    seq: 1,
    role: "user",
    botId: null as string | null,
    runId: "run-A",
    blocks: [block],
    createdAt: new Date(0),
  };
  result.prisma.message!.findMany.mockResolvedValue([message]);
  result.prisma.artifact!.findMany.mockResolvedValue([row]);
  const get = vi.fn(async () => bytes);
  result.deps.artifacts = { get } as unknown as ArtifactStore;
  result.deps.sandbox.writeFile = vi.fn(async () => undefined);
  const binding = await mocks.binding();
  binding.profile.inputModalities = [kind];
  if (kind === "audio")
    Object.assign(binding.profile, {
      harness: "codex",
      runtimeVersion: EXECUTION_HARNESS_VERSIONS.codex,
      protocol: "openai-responses",
    });
  return { ...result, row, bytes, message, get, binding };
}

describe("executor primary harness routing", () => {
  it.each([false, true])(
    "requests exclusive checkout access only for a pinned profile (%s)",
    async (pinned) => {
      const f = fixture();
      if (!pinned) Reflect.set(f.run, "executionProfileSnapshot", null);
      await f.executor.continueRun("run-A", "worker-A");
      expect(mocks.acquire).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          computerId: "computer-A",
          botId: "bot-A",
          runId: "run-A",
          exclusive: pinned,
        }),
      );
    },
  );

  it.each(["image", "audio"] as const)(
    "hydrates scoped %s bytes directly into the selected native request",
    async (kind) => {
      const { executor, bytes, row, get, prisma, finalizeRun, piRun } = await attachedMedia(kind);
      await executor.continueRun("run-A", "worker-A");
      expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
      expect(mocks.nativeRun).toHaveBeenCalledOnce();
      const request = mocks.nativeRun.mock.calls[0]![0] as AgentRunRequest;
      const media = kind === "image" ? request.currentTurnImages : request.currentTurnAudio;
      expect(media).toEqual([{ name: row.name, mimeType: row.mimeType, data: bytes }]);
      expect(request.model).toMatchObject({
        acceptsImages: kind === "image",
        acceptsAudio: kind === "audio",
      });
      expect(prisma.artifact!.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: [row.id] }, spaceId: "space-A", userId: "user-A" },
        }),
      );
      expect(get).toHaveBeenCalledWith(
        row.storageKey,
        expect.objectContaining({ spaceId: "space-A", userId: "user-A" }),
        { maxBytes: row.size },
      );
      expect(piRun).not.toHaveBeenCalled();
    },
  );

  it.each(["missing", "foreign"])(
    "fails a %s current attachment before constructing a native runtime",
    async (kind) => {
      const { executor, prisma, row, finalizeRun, get } = await attachedMedia("image");
      if (kind === "missing") prisma.artifact!.findMany.mockResolvedValue([]);
      else row.userId = "other-user";
      await executor.continueRun("run-A", "worker-A");
      expect(mocks.factory).not.toHaveBeenCalled();
      expect(mocks.nativeRun).not.toHaveBeenCalled();
      expect(get).not.toHaveBeenCalled();
      expect(finalizeRun).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: "failed",
          error: expect.stringContaining("unavailable"),
        }),
      );
    },
  );

  it("preserves peer-bot history attribution when hydrating native group media", async () => {
    const { executor, message, prisma, bytes, finalizeRun } = await attachedMedia("image");
    Object.assign(message, { role: "bot", botId: "bot-B", runId: "run-B" });
    const thread = await prisma.thread!.findUniqueOrThrow();
    prisma.thread!.findUniqueOrThrow.mockResolvedValue({
      ...(thread as object),
      groupId: "group-A",
    });
    await executor.continueRun("run-A", "worker-A");
    expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
    const request = mocks.nativeRun.mock.calls[0]![0] as AgentRunRequest;
    expect(request.currentTurnImages).toEqual([]);
    expect(request.history).toContainEqual(
      expect.objectContaining({
        id: message.id,
        role: "user",
        content: expect.stringContaining("Message from bot bot-B"),
        images: [expect.objectContaining({ data: bytes })],
      }),
    );
  });

  it("keeps routine media context isolated from unrelated thread attachments", async () => {
    const { executor, run, get, finalizeRun } = await attachedMedia("image");
    run.trigger = "routine";
    await executor.continueRun("run-A", "worker-A");
    expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
    const request = mocks.nativeRun.mock.calls[0]![0] as AgentRunRequest;
    expect(request.currentTurnImages).toEqual([]);
    expect(
      request.history.every((message) => !message.images?.length && !message.audio?.length),
    ).toBe(true);
    expect(get).not.toHaveBeenCalled();
  });

  it("allows a call-end text transcript without pretending it is native audio", async () => {
    const { executor, run, prisma, finalizeRun } = fixture();
    run.trigger = "call_end";
    prisma.message!.findMany.mockResolvedValue([
      {
        id: "transcript-A",
        role: "user",
        seq: 1,
        runId: "previous",
        blocks: [{ kind: "text", text: "Call transcript: please summarize." }],
        createdAt: new Date(0),
      },
    ]);
    await executor.continueRun("run-A", "worker-A");
    expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
    const request = mocks.nativeRun.mock.calls[0]![0] as AgentRunRequest;
    expect(request.currentTurnAudio).toEqual([]);
    expect(request.history).toContainEqual(
      expect.objectContaining({
        role: "user",
        content: expect.stringContaining("Call transcript"),
      }),
    );
  });

  it.each(["claude", "codex", "kimi"] as const)(
    "executes %s directly without a Pi turn",
    async (harness) => {
      const binding = await mocks.binding();
      binding.profile.harness = harness;
      binding.profile.runtimeVersion = EXECUTION_HARNESS_VERSIONS[harness];
      binding.profile.protocol =
        harness === "claude"
          ? "anthropic"
          : harness === "codex"
            ? "openai-responses"
            : "openai-chat-completions";
      const { executor, piRun, finalizeRun } = fixture();
      await executor.continueRun("run-A", "worker-A").catch((error) => {
        throw new Error(`${String(error)}: ${JSON.stringify(mocks.error.mock.calls)}`);
      });
      expect(
        mocks.nativeRun,
        JSON.stringify({
          finalize: finalizeRun.mock.calls,
          errors: mocks.error.mock.calls,
          factory: mocks.factory.mock.calls.length,
        }),
      ).toHaveBeenCalledOnce();
      expect(piRun).not.toHaveBeenCalled();
      expect(mocks.factory).toHaveBeenCalledWith(
        expect.objectContaining({
          harness,
          accountId: "account-A",
          profileId: "profile-A",
          sessionEpoch: "epoch-A",
        }),
      );
      await mocks.factory.mock.calls[0]?.[0].onCheckpoint("opaque-checkpoint");
      expect(mocks.checkpoint).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          nativeSessionId: "opaque-checkpoint",
          runId: "run-A",
          profileId: "profile-A",
        }),
      );
      expect(mocks.nativeRun.mock.calls[0]?.[0].model).toMatchObject({
        provider: "provider-A",
        id: "model-A",
        apiKey: "fake-profile-key",
      });
      expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
    },
  );
  it("replays the exact approved effect, then rejects an ambiguous completed-effect repeat", async () => {
    const args = { path: "MEMORY.md", content: "same update" };
    const effects: Effect[] = [
      {
        id: "old",
        runId: "run-A",
        spaceId: "space-A",
        kind: "remember",
        idempotencyKey: toolEffectIdempotencyKey("run-A", "remember", args),
        status: "completed",
        request: args,
        result: { ok: true },
      },
      {
        id: "approved",
        runId: "run-A",
        spaceId: "space-A",
        kind: "remember",
        idempotencyKey: toolEffectIdempotencyKey("run-A", "remember", args, 1),
        status: "approved",
        request: args,
      },
    ];
    mocks.nativeRun.mockImplementation(async function* (request: AgentRunRequest) {
      await request.executeTool!("remember", args, "new-vendor-call-0");
      await request.executeTool!("remember", args, "new-vendor-call-1");
      yield { type: "text", text: "Done" };
      yield { type: "done" };
    });
    const { executor, memoryCommit, finalizeRun } = fixture(true, effects);
    await executor.continueRun("run-A", "worker-A");
    expect(finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "failed",
        error: expect.stringContaining("prevent a duplicate effect"),
      }),
    );
    expect(memoryCommit).toHaveBeenCalledOnce();
    expect(effects.find((effect) => effect.id === "approved")?.status).toBe("completed");
    expect(effects.map((effect) => effect.idempotencyKey)).not.toContain(
      toolEffectIdempotencyKey("run-A", "remember", args, 2),
    );
  });
  it.each(["claude", "codex", "kimi"] as const)(
    "fails closed on a %s retry whose completed host effect lacks a native result",
    async (harness) => {
      const binding = await mocks.binding();
      Object.assign(binding.profile, {
        harness,
        runtimeVersion: EXECUTION_HARNESS_VERSIONS[harness],
        protocol:
          harness === "claude"
            ? "anthropic"
            : harness === "codex"
              ? "openai-responses"
              : "openai-chat-completions",
      });
      const args = { path: "MEMORY.md", content: "already applied" };
      const effects: Effect[] = [
        {
          id: "completed-before-pause",
          runId: "run-A",
          spaceId: "space-A",
          kind: "remember",
          idempotencyKey: toolEffectIdempotencyKey("run-A", "remember", args),
          status: "completed",
          request: args,
          result: { ok: true },
        },
      ];
      mocks.nativeRun.mockImplementation(async function* (request: AgentRunRequest) {
        await request.executeTool!("remember", args, "recreated-native-call-id");
        yield { type: "done" };
      });
      const { executor, memoryCommit, finalizeRun } = fixture(true, effects);
      await executor.continueRun("run-A", "worker-A");
      expect(memoryCommit).not.toHaveBeenCalled();
      expect(effects).toHaveLength(1);
      expect(finalizeRun).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: "failed",
          error: expect.stringContaining("prevent a duplicate effect"),
        }),
      );
    },
  );

  it("permits distinct arguments after native resume while fencing the prior signature", async () => {
    const oldArgs = { path: "MEMORY.md", content: "first update" };
    const newArgs = { path: "MEMORY.md", content: "different update" };
    const effects: Effect[] = [
      {
        id: "old",
        runId: "run-A",
        spaceId: "space-A",
        kind: "remember",
        idempotencyKey: toolEffectIdempotencyKey("run-A", "remember", oldArgs),
        status: "completed",
        request: oldArgs,
        result: { ok: true },
      },
    ];
    mocks.nativeRun.mockImplementation(async function* (request: AgentRunRequest) {
      await request.executeTool!("remember", newArgs, "new-native-call");
      yield { type: "text", text: "Done" };
      yield { type: "done" };
    });
    const { executor, memoryCommit, finalizeRun } = fixture(true, effects);
    await executor.continueRun("run-A", "worker-A");
    expect(memoryCommit).toHaveBeenCalledOnce();
    expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
  });

  it("permits the same requested action in a fresh run and repeated calls within that attempt", async () => {
    const args = { path: "MEMORY.md", content: "intended repeat" };
    const effects: Effect[] = [
      {
        id: "previous-run-effect",
        runId: "run-old",
        spaceId: "space-A",
        kind: "remember",
        idempotencyKey: toolEffectIdempotencyKey("run-old", "remember", args),
        status: "completed",
        request: args,
        result: { ok: true },
      },
    ];
    mocks.nativeRun.mockImplementation(async function* (request: AgentRunRequest) {
      await request.executeTool!("remember", args, "new-call-1");
      await request.executeTool!("remember", args, "new-call-2");
      yield { type: "text", text: "Done" };
      yield { type: "done" };
    });
    const { executor, memoryCommit, finalizeRun } = fixture(true, effects);
    await executor.continueRun("run-A", "worker-A");
    expect(memoryCommit).toHaveBeenCalledTimes(2);
    expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
  });

  it("fails an incomplete native stream without rerouting or reporting completion", async () => {
    mocks.nativeRun.mockImplementation(async function* () {
      yield { type: "text", text: "Partial answer" };
    });
    const { executor, piRun, finalizeRun } = fixture();
    await executor.continueRun("run-A", "worker-A");
    expect(piRun).not.toHaveBeenCalled();
    expect(finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "failed",
        error: expect.stringContaining("terminal result"),
      }),
    );
    expect(mocks.checkpoint).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome: "interrupted" }),
    );
  });
  it("pauses a native question through the existing durable input path", async () => {
    mocks.nativeRun.mockImplementation(async function* () {
      yield {
        type: "ask",
        text: "Which branch?",
        actions: [
          { id: "one", label: "First" },
          { id: "two", label: "Second" },
        ],
      };
    });
    const { executor, piRun, finalizeRun, pauseRunForInput } = fixture();
    await executor.continueRun("run-A", "worker-A");
    expect(piRun).not.toHaveBeenCalled();
    expect(finalizeRun).not.toHaveBeenCalled();
    expect(pauseRunForInput).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-A",
        offeredActions: [
          { id: "one", label: "First" },
          { id: "two", label: "Second" },
        ],
      }),
    );
    expect(mocks.checkpoint).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome: "paused" }),
    );
  });
  it("rejects disabled native execution without silently falling back to Pi", async () => {
    const { executor, piRun, finalizeRun } = fixture(false);
    await executor.continueRun("run-A", "worker-A").catch((error) => {
      throw new Error(`${String(error)}: ${JSON.stringify(mocks.error.mock.calls)}`);
    });
    expect(piRun).not.toHaveBeenCalled();
    expect(mocks.nativeRun).not.toHaveBeenCalled();
    expect(finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "failed", error: expect.stringContaining("disabled") }),
    );
  });
});

async function piFixture() {
  const f = fixture();
  const binding = await mocks.binding();
  Object.assign(binding.profile, {
    harness: "pi",
    provider: "openai-compatible",
    modelId: "custom-model",
    protocol: "openai-chat-completions",
    runtimeVersion: EXECUTION_HARNESS_VERSIONS.pi,
    authScheme: "api-key",
    modelRoles: {},
  });
  binding.credential.provider = "openai-compatible";
  vi.mocked(f.deps.secretStore.load).mockResolvedValue(
    JSON.stringify({
      kind: "openai_compatible",
      baseUrl: binding.profile.endpoint,
      apiKey: "fake-exact-account-key",
    }),
  );
  f.piRun.mockImplementation(async function* () {
    yield { type: "done" };
  });
  return { ...f, binding };
}

describe("explicit Pi account isolation", () => {
  it("pins the same-provider account and gives helpers no alternate-account resolver", async () => {
    const f = await piFixture();
    await f.executor.continueRun("run-A", "worker-A");
    expect(f.finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
    const request = f.piRun.mock.calls[0]?.[0] as AgentRunRequest;
    expect(request.model.apiKey).toBe("fake-exact-account-key");
    expect(request.resolveModel).toBeUndefined();
    expect(request.resolveFallbackModel).toBeUndefined();
    expect(request.fallbackModels).toEqual([]);
    expect(f.prisma.secret!.findFirst).toHaveBeenCalledWith({
      where: { id: "secret-A", userId: "user-A", spaceId: null },
    });
    expect(mocks.factory).not.toHaveBeenCalled();
  });
  it("supplies explicit handover instructions when returning to Pi", async () => {
    const f = await piFixture();
    mocks.handover.mockResolvedValue({
      previousHarness: "codex",
      currentHarness: "pi",
      summary: "Execution handover: codex to pi. Preserve unfinished work.",
    });
    await f.executor.continueRun("run-A", "worker-A");
    expect(f.piRun.mock.calls[0]?.[0].instructions).toContain("Execution handover: codex to pi");
  });
  it("aborts a tool-free Pi stream when its exact account is revoked", async () => {
    vi.useFakeTimers();
    try {
      const f = await piFixture();
      let enter!: () => void;
      const started = new Promise<void>((resolve) => {
        enter = resolve;
      });
      let signal: AbortSignal | undefined;
      f.piRun.mockImplementation(async function* (_request, context) {
        signal = context.signal;
        enter();
        await new Promise<void>((resolve) =>
          context.signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        context.signal.throwIfAborted();
      });
      const running = f.executor.continueRun("run-A", "worker-A");
      await started;
      mocks.binding.mockRejectedValueOnce(new Error("Account was revoked"));
      await vi.advanceTimersByTimeAsync(2001);
      await running;
      expect(signal?.aborted).toBe(true);
      expect(f.finalizeRun).not.toHaveBeenCalledWith(
        expect.objectContaining({ outcome: "completed" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

async function nativeLoginFixture() {
  const f = fixture();
  const binding = await mocks.binding();
  const account = {
    kind: "native_login",
    harness: "codex",
    installationId: "a".repeat(32),
    connectionId: "11111111-1111-4111-8111-111111111111",
    epoch: "22222222-2222-4222-8222-222222222222",
    computerId: "computer-A",
    computerProviderRef: "container-A",
    computerHomeKey: "home-A",
    spaceId: "space-A",
    state: "ready",
    region: "global",
  };
  Object.assign(binding.profile, {
    harness: "codex",
    provider: "native-codex",
    protocol: "openai-responses",
    runtimeVersion: EXECUTION_HARNESS_VERSIONS.codex,
    endpoint: "https://chatgpt.com/backend-api/codex",
    computerId: "computer-A",
    authScheme: "api-key",
    modelRoles: {},
  });
  binding.credential.provider = "native-codex";
  const bot = await f.prisma.bot!.findUniqueOrThrow();
  f.prisma.bot!.findUniqueOrThrow.mockResolvedValue({
    ...(bot as object),
    computerId: "computer-A",
    computer: {
      id: "computer-A",
      scope: "dedicated",
      kind: "docker",
      providerRef: "container-A",
      homeKey: "home-A",
    },
  });
  f.deps.nativeLoginSelfHosted = true;
  vi.mocked(f.deps.secretStore.load).mockImplementation(async () => JSON.stringify(account));
  return { ...f, account, binding };
}

describe("executor native-login boundary", () => {
  it("passes its descriptor through the selected native runtime without an API key", async () => {
    const f = await nativeLoginFixture();
    await f.executor.continueRun("run-A", "worker-A");
    expect(f.finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
    expect(mocks.factory).toHaveBeenCalledWith(
      expect.objectContaining({ nativeLogin: true, harness: "codex" }),
    );
    const model = mocks.nativeRun.mock.calls[0]?.[0].model;
    expect(model.nativeLogin).toEqual(f.account);
    expect(model.apiKey).toBeUndefined();
    expect(f.piRun).not.toHaveBeenCalled();
  });
  it.each(["disabled", "installation", "home", "container", "missing-namespace"])(
    "fails closed before launching a %s native account",
    async (failure) => {
      const f = await nativeLoginFixture();
      if (failure === "disabled") f.deps.nativeLoginSelfHosted = false;
      if (failure === "installation") f.account.installationId = "b".repeat(32);
      if (failure === "home") f.account.computerHomeKey = "other-home";
      if (failure === "container") f.account.computerProviderRef = "other-container";
      if (failure === "missing-namespace") f.deps.sandbox.nativeStateInstallationId = undefined;
      await f.executor.continueRun("run-A", "worker-A");
      expect(f.finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
      expect(mocks.factory).not.toHaveBeenCalled();
      expect(f.piRun).not.toHaveBeenCalled();
    },
  );
  it.each(["routine", "bot_message", "follow_up", "webhook"])(
    "rejects native Kimi %s automation",
    async (trigger) => {
      const f = await nativeLoginFixture();
      f.run.trigger = trigger;
      f.account.harness = "kimi";
      Object.assign(f.binding.profile, {
        harness: "kimi",
        provider: "native-kimi",
        protocol: "openai-chat-completions",
        runtimeVersion: EXECUTION_HARNESS_VERSIONS.kimi,
        endpoint: "https://api.kimi.ai/coding/v1",
      });
      f.binding.credential.provider = "native-kimi";
      await f.executor.continueRun("run-A", "worker-A");
      expect(f.finalizeRun).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: "failed",
          error: expect.stringContaining("interactive"),
        }),
      );
      expect(mocks.factory).not.toHaveBeenCalled();
    },
  );
});

describe("pinned profile background routing", () => {
  it.each(["bot_message", "routine"])(
    "uses the receiving bot native profile for %s without a Pi wrapper",
    async (trigger) => {
      const f = fixture();
      f.run.trigger = trigger;
      const binding = await mocks.binding();
      binding.profile.harness = "codex";
      binding.profile.protocol = "openai-responses";
      binding.profile.runtimeVersion = EXECUTION_HARNESS_VERSIONS.codex;
      await f.executor.continueRun("run-A", "worker-A");
      expect(f.finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
      expect(mocks.factory).toHaveBeenCalledWith(
        expect.objectContaining({
          harness: "codex",
          accountId: "account-A",
          profileId: "profile-A",
          context: expect.objectContaining({ botId: "bot-A", runId: "run-A" }),
        }),
      );
      expect(mocks.nativeRun.mock.calls[0]?.[0].model.apiKey).toBe("fake-profile-key");
      expect(f.piRun).not.toHaveBeenCalled();
    },
  );
});
