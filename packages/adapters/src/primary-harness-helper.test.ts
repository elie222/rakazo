import type {
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
  ComputerRef,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import { EXECUTION_HARNESS_VERSIONS } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { approvalPausedToolResult } from "./approval-effect.js";
import type { PrimaryHarnessHelperState } from "./primary-harness-helper.js";
import { createPrimaryHarnessHelper } from "./primary-harness-helper.js";
import { NativeHarnessPaused } from "./primary-harness-protocol.js";
import type { PrimaryHarnessRuntimeOptions } from "./primary-harness-runtime.js";

const args = { name: "reviewer", task: "Inspect the authorized note." };
type Child = (
  request: AgentRunRequest,
  options: PrimaryHarnessRuntimeOptions,
) => AsyncIterable<AgentRuntimeEvent>;
const success: Child = async function* () {
  yield { type: "text", text: "Reviewed the note." };
  yield { type: "done" };
};
function setup(child: Child = success, states = new Map<string, PrimaryHarnessHelperState>()) {
  const controller = new AbortController();
  const emitted: AgentRuntimeEvent[] = [];
  const request: AgentRunRequest = {
    runId: "parent-run",
    botId: "bot",
    threadId: "thread",
    prompt: "Parent task.",
    instructions: "Never bypass authorization.",
    history: [{ role: "user", content: "Parent private history." }],
    model: {
      provider: "custom",
      id: "pinned-model",
      apiKey: "fake-key",
      baseUrl: "https://example.test/v1",
    },
    tools: [
      "read_file",
      "write_file",
      "request_secret",
      "run_subagent",
      "spawn_bot",
      "message_bot",
      "ask_user",
      "request_takeover",
    ].map((name) => ({
      name,
      description: name,
      inputSchema: { type: "object" },
      route: { connectorId: "authorized", resourceId: "resource", toolName: name },
    })),
    fallbackModels: [{ provider: "other", id: "other" }],
    resolveModel: vi.fn(),
    resolveFallbackModel: vi.fn(),
    claimSteering: vi.fn(),
    resumeFromCheckpoint: "parent-private-checkpoint",
    executeTool: vi.fn().mockResolvedValue("read result"),
    onToolCompleted: vi.fn(),
    onUsage: vi.fn(),
  };
  const options: PrimaryHarnessRuntimeOptions = {
    harness: "codex",
    protocol: "openai-responses",
    runtimeVersion: EXECUTION_HARNESS_VERSIONS.codex,
    accountId: "account",
    profileId: "profile",
    profileRevision: 1,
    sessionEpoch: "epoch",
    sandbox: {} as SandboxProvider,
    computer: {} as ComputerRef,
    context: {
      operationId: "operation",
      traceId: "trace",
      spaceId: "space",
      userId: "user",
      botId: "bot",
      runId: "parent-run",
      signal: controller.signal,
    },
    nativeCheckpoint: "parent-native-checkpoint",
    onCheckpoint: vi.fn(),
  };
  const created: Array<{ options: PrimaryHarnessRuntimeOptions; request: AgentRunRequest }> = [];
  const abort = vi.fn(async () => undefined);
  const createRuntime = vi.fn(
    (runtimeOptions: PrimaryHarnessRuntimeOptions): AgentRuntime => ({
      describe: () => ({
        id: "test",
        adapterVersion: "1",
        contractVersion: "1",
        capabilities: { streaming: true, compaction: false, tools: true, scripted: false },
      }),
      run(childRequest) {
        created.push({ options: runtimeOptions, request: childRequest });
        return child(childRequest, runtimeOptions);
      },
      abort,
    }),
  );
  const saveState = vi.fn(async (key: string, state: PrimaryHarnessHelperState) => {
    states.set(key, structuredClone(state));
  });
  const config = {
    options,
    request,
    signal: controller.signal,
    emit: (event: AgentRuntimeEvent) => emitted.push(event),
    createRuntime,
    depth: 0,
    getState: (key: string) => states.get(key),
    saveState,
  };
  return {
    config,
    helper: createPrimaryHarnessHelper(config),
    request,
    options,
    created,
    emitted,
    controller,
    abort,
    createRuntime,
    saveState,
    states,
  };
}

const usage = {
  type: "usage" as const,
  provider: "custom",
  model: "pinned-model",
  callId: "native-usage",
  inputTokens: 10,
  outputTokens: 2,
};

describe("mediated native helpers", () => {
  it("uses the exact account/runtime/model with an isolated epoch and no inherited fallback or parent session", async () => {
    const f = setup();
    await expect(f.helper.run(args, "call-1")).resolves.toBe("Reviewed the note.");
    const child = f.created[0]!;
    expect(child.options).toMatchObject({
      harness: "codex",
      accountId: "account",
      profileId: "profile",
      profileRevision: 1,
      helperDepth: 1,
    });
    expect(child.options.context.runId).toBe("parent-run");
    expect(child.options.sessionEpoch).not.toBe("epoch");
    expect(child.options.nativeCheckpoint).toBeUndefined();
    expect(child.request.model).toEqual(f.request.model);
    expect(child.request.runId).toBe("parent-run");
    expect(child.request.history).toEqual([]);
    expect(child.request.instructions).toContain("Never bypass authorization.");
    for (const field of [
      "fallbackModels",
      "resolveModel",
      "resolveFallbackModel",
      "claimSteering",
      "resumeFromCheckpoint",
      "script",
    ])
      expect(child.request).not.toHaveProperty(field);
    expect(child.request.tools.map((tool) => tool.name)).toEqual([
      "read_file",
      "write_file",
      "request_secret",
      "ask_user",
      "request_takeover",
    ]);
    expect(f.options.onCheckpoint).not.toHaveBeenCalled();
    expect(f.abort).toHaveBeenCalledWith("parent-run");
    expect(f.emitted.at(-1)).toMatchObject({
      type: "subagent",
      status: "completed",
      result: "Reviewed the note.",
    });
  });

  it("preserves scoped image/audio bytes and source identity under the same model/account", async () => {
    const f = setup();
    const image = { name: "image.png", mimeType: "image/png" as const, data: new Uint8Array([1]) };
    const audio = { name: "audio.wav", mimeType: "audio/wav" as const, data: new Uint8Array([2]) };
    f.request.sourceMessageId = "source";
    f.request.currentTurnImages = [image];
    f.request.currentTurnAudio = [audio];
    f.request.history.push({
      id: "group-source",
      role: "assistant",
      content: "Attached by group bot",
      images: [image],
    });
    f.request.model.acceptsImages = true;
    f.request.model.acceptsAudio = true;
    await f.helper.run(args, "media-call");
    const child = f.created[0]!;
    expect(child.request.sourceMessageId).toBe("source");
    expect(child.request.currentTurnImages).toEqual([image]);
    expect(child.request.currentTurnAudio).toEqual([audio]);
    expect(child.request.history).toEqual([f.request.history[1]]);
    expect(child.request.model).toEqual(f.request.model);
    expect(child.options.accountId).toBe(f.options.accountId);
  });

  it("persists the child checkpoint before routing effects and ignores forged routes", async () => {
    let durable = false;
    const f = setup(async function* (request, options) {
      await options.onCheckpoint!("child-checkpoint");
      expect(durable).toBe(true);
      yield { type: "tool", name: "write_file", args: { path: "note" }, executionId: "child-tool" };
      const first = request.executeTool!("write_file", { path: "note" }, "child-tool", {
        connectorId: "forged",
        toolName: "remove",
      });
      const second = request.executeTool!("write_file", { path: "note" }, "child-tool");
      expect(await first).toBe(await second);
      await request.onToolCompleted!({
        name: "write_file",
        executionId: "child-tool",
        durationMs: 1,
      });
      yield { type: "text", text: "Updated." };
      yield { type: "done" };
    });
    f.saveState.mockImplementation(async (key, state) => {
      durable ||= state.checkpoint === "child-checkpoint";
      f.states.set(key, state);
    });
    await f.helper.run(args, "call");
    expect(f.request.executeTool).toHaveBeenCalledTimes(1);
    const effect = vi.mocked(f.request.executeTool!).mock.calls[0]!;
    expect(effect[2]).toMatch(/^native-helper-tool-[a-f0-9]{64}$/);
    expect(effect[3]).toEqual(f.request.tools.find((tool) => tool.name === "write_file")!.route);
    expect(f.request.onToolCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ executionId: effect[2] }),
    );
    expect(f.emitted).toContainEqual(
      expect.objectContaining({ type: "tool", executionId: effect[2] }),
    );
    expect([...f.states.values()][0]).toMatchObject({
      checkpoint: "child-checkpoint",
      result: "Updated.",
    });
  });

  it("namespaces producer-side usage once for each child and forwards accounted events", async () => {
    const f = setup(async function* (request) {
      await request.onUsage!(usage);
      yield { ...usage, accounted: true };
      yield { type: "text", text: "Done." };
      yield { type: "done" };
    });
    await Promise.all([
      f.helper.run(args, "call-1"),
      f.helper.run({ ...args, task: "A different task." }, "call-2"),
    ]);
    expect(f.request.onUsage).toHaveBeenCalledTimes(2);
    const first = vi.mocked(f.request.onUsage!).mock.calls[0]![0];
    const second = vi.mocked(f.request.onUsage!).mock.calls[1]![0];
    expect(first).toMatchObject({ operationKind: "subagent", inputTokens: 10, outputTokens: 2 });
    expect(first.agentId).not.toBe(second.agentId);
    expect(first.callId).not.toBe(second.callId);
    expect(f.emitted.filter((event) => event.type === "usage")).toEqual([
      { ...first, accounted: true },
      { ...second, accounted: true },
    ]);
  });

  it("accounts unaccounted child usage before forwarding it", async () => {
    const f = setup(async function* () {
      yield usage;
      yield { type: "done" };
    });
    await f.helper.run(args, "call");
    expect(f.request.onUsage).toHaveBeenCalledTimes(1);
    expect(f.emitted).toContainEqual(
      expect.objectContaining({ type: "usage", accounted: true, operationKind: "subagent" }),
    );
  });

  it.each(["model_provider", "model_id"])(
    "rejects every explicit %s override without resolving a new model",
    async (field) => {
      const f = setup();
      await expect(f.helper.run({ ...args, [field]: "" }, "call")).rejects.toThrow("overrides");
      expect(f.createRuntime).not.toHaveBeenCalled();
      expect(f.request.resolveModel).not.toHaveBeenCalled();
    },
  );

  it("rejects nesting, malformed arguments, and changed duplicate identities", async () => {
    const f = setup();
    await expect(
      createPrimaryHarnessHelper({ ...f.config, depth: 1 }).run(args, "call"),
    ).rejects.toThrow("delegate");
    await expect(f.helper.run({ ...args, task: "" }, "empty")).rejects.toThrow("task");
    await expect(f.helper.run({ ...args, name: "x".repeat(81) }, "long")).rejects.toThrow("name");
    await expect(f.helper.run(args, "")).rejects.toThrow("identity");
    const first = f.helper.run(args, "call");
    expect(f.helper.run(args, "call")).toBe(first);
    await expect(f.helper.run({ ...args, task: "Changed" }, "call")).rejects.toThrow(
      "identity changed",
    );
    await first;
    expect(f.createRuntime).toHaveBeenCalledTimes(1);
  });

  it.each(["ask_user", "request_takeover", "run_subagent", "spawn_bot", "missing_tool"])(
    "rejects a forged %s child tool instead of invoking parent placeholders",
    async (name) => {
      const f = setup(async function* (request) {
        await request.executeTool!(name, {}, "tool");
        yield { type: "done" };
      });
      await expect(f.helper.run(args, "call")).rejects.toThrow("unauthorized");
      expect(f.request.executeTool).not.toHaveBeenCalled();
      expect(
        f.emitted.some((event) => event.type === "subagent" && event.status === "completed"),
      ).toBe(false);
    },
  );

  it("rejects changed child effect identity and never executes the second payload", async () => {
    const f = setup(async function* (request) {
      await request.executeTool!("write_file", { path: "one" }, "tool");
      await request.executeTool!("write_file", { path: "two" }, "tool");
      yield { type: "done" };
    });
    await expect(f.helper.run(args, "call")).rejects.toThrow("identity changed");
    expect(f.request.executeTool).toHaveBeenCalledTimes(1);
  });

  it.each([
    { type: "ask", text: "Question?" },
    { type: "takeover", reason: "Input" },
  ] as AgentRuntimeEvent[])("rejects unexpected user control events: $type", async (event) => {
    const f = setup(async function* () {
      yield event;
      yield { type: "done" };
    });
    await expect(f.helper.run(args, "call")).rejects.toThrow("durable checkpoint");
    expect(f.emitted.some((value) => value.type === "ask" || value.type === "takeover")).toBe(
      false,
    );
  });

  it("propagates approval pause only after saving child state, then resumes despite changed native IDs", async () => {
    const states = new Map<string, PrimaryHarnessHelperState>();
    const first = setup(async function* (request, options) {
      await options.onCheckpoint!("pending-native-session");
      await request.executeTool!("write_file", {}, "native-first-id");
      await request.onUsage!(usage);
      yield { ...usage, accounted: true };
      // Native runtime ends without a done after approval or protected input.
    }, states);
    first.request.executeTool = vi.fn().mockResolvedValue(approvalPausedToolResult());
    await expect(first.helper.run(args, "native-wrapper-old")).rejects.toBeInstanceOf(
      NativeHarnessPaused,
    );
    expect([...states.values()][0]?.checkpoint).toBe("pending-native-session");
    expect([...states.values()][0]?.result).toBeUndefined();
    expect(
      first.emitted.some((event) => event.type === "subagent" && event.status === "completed"),
    ).toBe(false);
    const resumed = setup(async function* (_request, options) {
      expect(options.nativeCheckpoint).toBe("pending-native-session");
      yield { type: "text", text: "Approved work completed." };
      yield { type: "done" };
    }, states);
    await expect(resumed.helper.run(args, "native-wrapper-new")).resolves.toBe(
      "Approved work completed.",
    );
    expect(resumed.created[0]?.options.sessionEpoch).toBe(first.created[0]?.options.sessionEpoch);
  });

  it("returns the durable identical bounded result without new model calls after interruption", async () => {
    const first = setup(async function* () {
      yield { type: "text", text: "界".repeat(2000) };
      yield { type: "done" };
    });
    const result = await first.helper.run(args, "old-id");
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(1024);
    expect(result).toContain("[Result truncated.]");
    expect(result).not.toContain("\ufffd");
    const resumed = setup(success, first.states);
    await expect(resumed.helper.run(args, "new-id")).resolves.toBe(result);
    expect(resumed.createRuntime).not.toHaveBeenCalled();
    resumed.request.runId = "new-parent-run";
    await expect(createPrimaryHarnessHelper(resumed.config).run(args, "new-id")).resolves.toBe(
      "Reviewed the note.",
    );
    expect(resumed.createRuntime).toHaveBeenCalledTimes(1);
  });

  it("rejects ambiguous identical requests and isolates distinct tasks and account scope", async () => {
    const first = setup();
    await first.helper.run(args, "one");
    await expect(first.helper.run(args, "two")).rejects.toThrow("identical native helper request");
    await first.helper.run({ ...args, task: "Different work." }, "three");
    expect(first.states.size).toBe(2);
    expect(first.created[0]?.options.sessionEpoch).not.toBe(first.created[1]?.options.sessionEpoch);
    const copied = setup(success, first.states);
    copied.options.accountId = "other-account";
    await expect(copied.helper.run(args, "changed-id")).rejects.toThrow(
      "checkpoint does not match",
    );
    expect(copied.createRuntime).not.toHaveBeenCalled();
  });

  it("resumes only the paused distinct helper when an earlier completed helper is not replayed", async () => {
    const first = setup(async function* (request, options) {
      if (request.prompt === "Paused task") {
        await options.onCheckpoint!("paused-child-session");
        await request.executeTool!("write_file", {}, "pending-tool");
        return;
      }
      yield { type: "text", text: "Earlier helper result." };
      yield { type: "done" };
    });
    first.request.executeTool = vi.fn().mockResolvedValue(approvalPausedToolResult());
    await first.helper.run(args, "earlier");
    await expect(
      first.helper.run({ ...args, task: "Paused task" }, "pending"),
    ).rejects.toBeInstanceOf(NativeHarnessPaused);
    const resumed = setup(async function* (_request, options) {
      expect(options.nativeCheckpoint).toBe("paused-child-session");
      yield { type: "text", text: "Resumed paused helper." };
      yield { type: "done" };
    }, first.states);
    await expect(
      resumed.helper.run({ ...args, task: "Paused task" }, "new-native-id"),
    ).resolves.toBe("Resumed paused helper.");
    expect(resumed.createRuntime).toHaveBeenCalledTimes(1);
  });

  it("does not report helper completion before its result is durable", async () => {
    const f = setup();
    f.saveState.mockImplementation(async (key, state) => {
      if (state.result !== undefined) throw new Error("Lease lost before result save");
      f.states.set(key, state);
    });
    await expect(f.helper.run(args, "call")).rejects.toThrow("Lease lost");
    expect(
      f.emitted.some((event) => event.type === "subagent" && event.status === "completed"),
    ).toBe(false);
    expect([...f.states.values()][0]?.result).toBeUndefined();
    expect(f.abort).toHaveBeenCalled();
  });

  it("allows at most four simultaneous helper calls and rejects additional work before spawning", async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = setup(async function* () {
      await wait;
      yield { type: "done" };
    });
    const pending = Array.from({ length: 4 }, (_, index) =>
      f.helper.run({ ...args, task: `Task ${index}` }, `call-${index}`),
    );
    await expect(f.helper.run(args, "fifth")).rejects.toThrow("limit");
    await vi.waitFor(() => expect(f.createRuntime).toHaveBeenCalledTimes(4));
    release();
    await Promise.all(pending);
  });

  it("cancels children with the parent and awaits their iterator cleanup", async () => {
    let cleaned = false;
    const f = setup(async function* (_request, options) {
      try {
        await new Promise<void>((resolve) =>
          options.context.signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        options.context.signal.throwIfAborted();
        yield { type: "done" };
      } finally {
        await Promise.resolve();
        cleaned = true;
      }
    });
    const result = f.helper.run(args, "call");
    const rejected = expect(result).rejects.toThrow();
    await vi.waitFor(() => expect(f.created).toHaveLength(1));
    f.controller.abort();
    await rejected;
    expect(cleaned).toBe(true);
    expect(f.abort).toHaveBeenCalledWith("parent-run");
    expect(f.emitted.at(-1)).toMatchObject({
      type: "subagent",
      status: "failed",
      result: "Helper cancelled.",
    });
  });

  it("does not start after cancellation or failed durable state writes", async () => {
    const cancelled = setup();
    cancelled.controller.abort();
    await expect(cancelled.helper.run(args, "call")).rejects.toThrow();
    expect(cancelled.createRuntime).not.toHaveBeenCalled();
    const failed = setup();
    failed.saveState.mockRejectedValue(new Error("Lease lost"));
    await expect(failed.helper.run(args, "call")).rejects.toThrow("Lease lost");
    expect(failed.createRuntime).not.toHaveBeenCalled();
  });

  it("fails closed on an oversized checkpoint before an external effect", async () => {
    const f = setup(async function* (request, options) {
      await options.onCheckpoint!("x".repeat(2049));
      await request.executeTool!("write_file", {}, "id");
      yield { type: "done" };
    });
    await expect(f.helper.run(args, "call")).rejects.toThrow("limit");
    expect(f.request.executeTool).not.toHaveBeenCalled();
    expect(f.abort).toHaveBeenCalled();
  });

  it("never turns incomplete output or a provider error into success", async () => {
    const incomplete = setup(async function* () {
      yield { type: "text", text: "Unfinished" };
    });
    await expect(incomplete.helper.run(args, "call")).rejects.toThrow("explicit completion");
    const failed = setup(async function* () {
      yield { type: "text", text: "Partial" };
      throw new Error("fake-secret-provider-error");
    });
    await expect(failed.helper.run(args, "call")).rejects.toThrow();
    expect(JSON.stringify(failed.emitted)).not.toContain("fake-secret-provider-error");
    expect(failed.emitted.at(-1)).toMatchObject({ status: "failed", result: "Helper failed." });
  });
});

it.each([
  {
    type: "ask",
    text: "Which file?",
    actions: [
      { id: "a", label: "One" },
      { id: "b", label: "Two" },
    ],
  },
  { type: "takeover", reason: "Confirm the browser dialog" },
] as AgentRuntimeEvent[])("persists and resumes helper input: $type", async (event) => {
  const first = setup(async function* (_request, options) {
    await options.onCheckpoint!("child-input-checkpoint");
    yield event;
    yield { type: "done" };
  });
  await expect(first.helper.run(args, "first-native-id")).rejects.toBeInstanceOf(
    NativeHarnessPaused,
  );
  expect(first.emitted).toContainEqual(event);
  expect([...first.states.values()][0]).toMatchObject({
    checkpoint: "child-input-checkpoint",
    waitingForInput: true,
  });
  const resumed = setup(async function* (request, options) {
    expect(options.nativeCheckpoint).toBe("child-input-checkpoint");
    expect(request.instructions).toContain("The user selected Two.");
    expect(request.history).toEqual([]);
    yield { type: "done", text: "Finished after input" };
  }, first.states);
  resumed.request.prompt = "The user selected Two.";
  await expect(resumed.helper.run(args, "changed-native-id")).resolves.toBe("Finished after input");
  expect([...resumed.states.values()][0]?.waitingForInput).toBe(false);
});

it.each([
  { type: "ask", text: "Which file?" },
  { type: "takeover", reason: "Confirm the browser dialog" },
] as AgentRuntimeEvent[])(
  "preserves pending input when a concurrent child checkpoint arrives: $type",
  async (event) => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let savingInput!: () => void;
    const inputStarted = new Promise<void>((resolve) => {
      savingInput = resolve;
    });
    const first = setup(async function* (_request, options) {
      await options.onCheckpoint!("initial-child-checkpoint");
      yield event;
    });
    first.saveState.mockImplementation(async (key, state) => {
      if (state.waitingForInput && state.checkpoint === "initial-child-checkpoint") {
        savingInput();
        await barrier;
      }
      first.states.set(key, structuredClone(state));
    });
    const paused = expect(first.helper.run(args, "first-native-id")).rejects.toBeInstanceOf(
      NativeHarnessPaused,
    );
    await inputStarted;
    // The runtime persists its pause checkpoint independently of the event consumer.
    const checkpoint = first.created[0]!.options.onCheckpoint!("latest-child-checkpoint");
    await Promise.resolve();
    expect(first.saveState).toHaveBeenCalledTimes(3);
    expect(first.emitted).not.toContainEqual(event);
    release();
    await Promise.all([checkpoint, paused]);
    expect([...first.states.values()][0]).toMatchObject({
      checkpoint: "latest-child-checkpoint",
      waitingForInput: true,
    });
    expect(first.emitted).toContainEqual(event);

    const resumed = setup(async function* (request, options) {
      expect(options.nativeCheckpoint).toBe("latest-child-checkpoint");
      expect(request.instructions).toContain("The user selected Two.");
      yield { type: "done", text: "Finished after input" };
    }, first.states);
    resumed.request.prompt = "The user selected Two.";
    await expect(resumed.helper.run(args, "changed-native-id")).resolves.toBe(
      "Finished after input",
    );
    expect([...resumed.states.values()][0]?.waitingForInput).toBe(false);
  },
);

it("does not apply queued state transformations after an input persistence failure", async () => {
  let rejectSave!: (error: Error) => void;
  const barrier = new Promise<void>((_resolve, reject) => {
    rejectSave = reject;
  });
  let savingInput!: () => void;
  const inputStarted = new Promise<void>((resolve) => {
    savingInput = resolve;
  });
  const first = setup(async function* (_request, options) {
    await options.onCheckpoint!("durable-child-checkpoint");
    yield { type: "ask", text: "Which file?" };
  });
  first.saveState.mockImplementation(async (key, state) => {
    if (state.waitingForInput) {
      savingInput();
      await barrier;
    }
    first.states.set(key, structuredClone(state));
  });
  const failed = expect(first.helper.run(args, "native-id")).rejects.toThrow("Lease lost");
  await inputStarted;
  const checkpoint = expect(
    first.created[0]!.options.onCheckpoint!("uncommitted-child-checkpoint"),
  ).rejects.toThrow("Lease lost");
  rejectSave(new Error("Lease lost"));
  await Promise.all([checkpoint, failed]);
  expect(first.saveState).toHaveBeenCalledTimes(3);
  expect([...first.states.values()][0]).toMatchObject({ checkpoint: "durable-child-checkpoint" });
  expect([...first.states.values()][0]?.waitingForInput).toBeUndefined();
  expect(first.emitted.some((event) => event.type === "ask")).toBe(false);
  expect(first.abort).toHaveBeenCalled();
});
