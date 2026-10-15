import type {
  AdapterContext,
  AgentRunRequest,
  AgentRuntimeEvent,
  ComputerRef,
  ProcessEvent,
  SandboxProcessHandle,
  SandboxProcessRequest,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import { EXECUTION_HARNESS_VERSIONS, nativeLoginEndpoint } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { approvalPausedToolResult } from "./approval-effect.js";
import { NativeEventQueue } from "./primary-harness-protocol.js";
import type { PrimaryHarness, PrimaryHarnessRuntimeOptions } from "./primary-harness-runtime.js";
import { createPrimaryHarnessRuntime } from "./primary-harness-runtime.js";

const nativeId = "aeeeeeee-1111-4111-8111-111111111111";
const tools = ["read_file", "write_file", "shell"].map((name) => ({
  name,
  description: name,
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
  route: { connectorId: "server-private-route", toolName: name },
}));

function input(): AgentRunRequest {
  return {
    runId: "run",
    botId: "bot",
    threadId: "thread",
    prompt: "Update the note and verify it.",
    instructions: "Use the authorized tool bridge.",
    history: [{ role: "user", content: "Peer bot Alice: the new requirement is blue." }],
    model: {
      provider: "custom",
      id: "configured-model",
      apiKey: "fake-key",
      baseUrl: "https://example.test/v1",
    },
    tools,
    executeTool: vi.fn().mockResolvedValue("ok"),
  };
}

type ToolCall = { name: string; args: Record<string, unknown>; id?: string };

/** Deterministic subprocess fixtures speak each actual vendor protocol, not a fake runtime API. */
function fixture(harness: PrimaryHarness, calls: ToolCall[] = []) {
  const events = new NativeEventQueue<ProcessEvent>();
  const sent: Record<string, unknown>[] = [];
  let index = 0;
  let activeNativeId = nativeId;
  const frame = (...messages: Record<string, unknown>[]) => {
    const line = `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`;
    // Exercise transport fragmentation, including multiple coalesced frames.
    events.push({ type: "stdout", data: line.slice(0, 13) });
    events.push({ type: "stdout", data: line.slice(13) });
  };
  const next = () => {
    const call = calls[index++];
    if (call) {
      const id = call.id ?? `tool-${index}`;
      if (harness === "claude")
        frame({
          id,
          method: "rakazo/tool",
          params: { name: call.name, args: call.args, callId: id },
        });
      else if (harness === "codex")
        frame({
          id,
          method: "item/tool/call",
          params: {
            threadId: activeNativeId,
            turnId: "turn",
            namespace: "rakazo",
            tool: call.name,
            arguments: call.args,
            callId: id,
          },
        });
      else
        frame({
          jsonrpc: "2.0",
          id,
          method: "rakazo/tool",
          params: { name: call.name, args: call.args, callId: id },
        });
      return;
    }
    if (harness === "claude")
      frame(
        {
          method: "rakazo/sdk",
          params: {
            type: "stream_event",
            event: {
              type: "content_block_delta",
              delta: { type: "text_delta", text: "Verified." },
            },
          },
        },
        {
          method: "rakazo/sdk",
          params: {
            type: "result",
            subtype: "success",
            is_error: false,
            result: "Verified.",
            modelUsage: {
              "configured-model": {
                inputTokens: 30,
                outputTokens: 12,
                cacheReadInputTokens: 0,
                cacheCreationInputTokens: 0,
                costUSD: 0.001,
              },
            },
          },
        },
      );
    else if (harness === "codex")
      frame(
        {
          method: "item/agentMessage/delta",
          params: { threadId: activeNativeId, turnId: "turn", delta: "Verified." },
        },
        {
          method: "thread/tokenUsage/updated",
          params: {
            threadId: activeNativeId,
            turnId: "turn",
            tokenUsage: {
              total: { inputTokens: 30, outputTokens: 12, cachedInputTokens: 0, totalTokens: 42 },
            },
          },
        },
        {
          method: "turn/completed",
          params: {
            threadId: activeNativeId,
            turn: { id: "turn", status: "completed", error: null },
          },
        },
      );
    else
      frame(
        {
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: activeNativeId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Verified." },
            },
          },
        },
        {
          method: "rakazo/usage",
          params: {
            callId: "wire-call",
            usage: { inputOther: 30, output: 12, inputCacheRead: 0, inputCacheCreation: 0 },
          },
        },
        {
          jsonrpc: "2.0",
          id: "rakazo:kimi:prompt",
          result: { stopReason: "end_turn", verifiedReason: "completed" },
        },
      );
  };
  const handle: SandboxProcessHandle = {
    events,
    writeStdin: vi.fn(async (text: string) => {
      const message = JSON.parse(text);
      sent.push(message);
      const p = message.params ?? {};
      if (message.method === "rakazo/start") {
        frame({
          id: message.id,
          result: { version: EXECUTION_HARNESS_VERSIONS[harness], nativeSessionId: activeNativeId },
        });
        if (harness === "claude") {
          frame({ method: "rakazo/session", params: { id: nativeId } });
          next();
        }
      } else if (message.method === "initialize") {
        frame({
          id: message.id,
          result:
            harness === "kimi"
              ? {
                  protocolVersion: 1,
                  agentInfo: { version: EXECUTION_HARNESS_VERSIONS.kimi },
                  agentCapabilities: { promptCapabilities: { image: true, audio: false } },
                }
              : { userAgent: "codex_cli_rs/0.162.1" },
        });
      } else if (message.method === "account/read") {
        frame({
          id: message.id,
          result: {
            account: { type: "chatgpt", email: "owner@example.invalid", planType: "plus" },
          },
        });
      } else if (message.method === "authenticate") {
        frame({ id: message.id, result: {} });
      } else if (message.method === "session/new" || message.method === "session/resume") {
        activeNativeId = p.sessionId ?? nativeId;
        frame({ id: message.id, result: { sessionId: activeNativeId } });
      } else if (message.method === "thread/start" || message.method === "thread/resume") {
        frame({ id: message.id, result: { thread: { id: nativeId } } });
      } else if (message.method === "turn/start") {
        frame({ id: message.id, result: { turn: { id: "turn" } } });
        next();
      } else if (message.method === "session/prompt") next();
      else if (!message.method && message.id && !message.error) next();
    }),
    closeStdin: vi.fn(async () => undefined),
    terminate: vi.fn(async () => events.end()),
  };
  const startProcess = vi.fn(
    async (_computer: ComputerRef, _request: SandboxProcessRequest) => handle,
  );
  const context: AdapterContext = {
    operationId: "op",
    traceId: "trace",
    spaceId: "space",
    userId: "user",
    botId: "bot",
    runId: "run",
    signal: new AbortController().signal,
  };
  const options: PrimaryHarnessRuntimeOptions = {
    harness,
    protocol:
      harness === "claude"
        ? "anthropic"
        : harness === "codex"
          ? "openai-responses"
          : "openai-chat-completions",
    runtimeVersion: EXECUTION_HARNESS_VERSIONS[harness],
    sandbox: { startProcess } as unknown as SandboxProvider,
    computer: {
      id: "computer",
      botId: "bot",
      providerRef: "computer-ref",
      kind: "docker",
      homePath: "/workspace",
    } as ComputerRef,
    context,
    accountId: "account",
    profileId: "profile",
    profileRevision: 1,
    sessionEpoch: "epoch",
  };
  return { options, startProcess, handle, sent, frame, events };
}

async function collect(
  runtime: ReturnType<typeof createPrimaryHarnessRuntime>,
  request: AgentRunRequest,
  output: AgentRuntimeEvent[] = [],
) {
  for await (const event of runtime.run(request)) output.push(event);
  return output;
}

describe.each<PrimaryHarness>(["claude", "codex", "kimi"])("%s primary harness", (harness) => {
  it("runs real protocol tool rounds through authorized read/write/shell and explicit completion", async () => {
    const f = fixture(harness, [
      { name: "read_file", args: { path: "note.md" } },
      { name: "write_file", args: { path: "note.md", content: "blue" } },
      { name: "shell", args: { command: "test note.md" } },
    ]);
    const request = input();
    let note = "red";
    const order: string[] = [];
    request.executeTool = vi.fn(async (name, args, _id, route) => {
      order.push(name);
      expect(route).toEqual(tools.find((tool) => tool.name === name)?.route);
      if (name === "write_file") note = String(args.content);
      if (name === "shell") expect(note).toBe("blue");
      return { content: note };
    });
    const onUsage = vi.fn(async () => undefined);
    request.onUsage = onUsage;
    const result = await collect(createPrimaryHarnessRuntime(f.options), request);
    expect(order).toEqual(["read_file", "write_file", "shell"]);
    expect(result.filter((event) => event.type === "text")).toEqual([
      { type: "text", text: "Verified." },
    ]);
    expect(result.at(-1)).toEqual({ type: "done" });
    expect(f.handle.terminate).toHaveBeenCalledExactlyOnceWith();
    expect(f.startProcess.mock.calls[0]?.[1].sessionScope).toEqual({
      threadId: "thread",
      profileId: "profile",
      profileRevision: 1,
      accountId: "account",
      epoch: "epoch",
      parentEpoch: "epoch",
    });
    expect(JSON.stringify(f.sent)).not.toContain("fake-key");
    expect(JSON.stringify(f.sent)).not.toContain("server-private-route");
    expect(f.options.sandbox).not.toHaveProperty("execute");
  });

  it("persists the first checkpoint before fast tool approval pause, with no success or tool reply", async () => {
    const f = fixture(harness, [{ name: "write_file", args: { path: "note.md" } }]);
    const request = input();
    let persisted = false;
    f.options.onCheckpoint = async () => {
      await Promise.resolve();
      persisted = true;
    };
    request.executeTool = vi.fn(async () => {
      expect(persisted).toBe(true);
      return approvalPausedToolResult();
    });
    const result = await collect(createPrimaryHarnessRuntime(f.options), request);
    expect(request.executeTool).toHaveBeenCalledTimes(1);
    expect(result.some((event) => event.type === "done")).toBe(false);
    expect(f.sent.some((message) => message.id === "tool-1" && message.result)).toBe(false);
    expect(f.handle.terminate).toHaveBeenCalledTimes(1);
  });

  it("does not execute tools if durable checkpoint persistence fails", async () => {
    const f = fixture(harness, [{ name: "write_file", args: { path: "note.md" } }]);
    f.options.onCheckpoint = async () => {
      throw new Error("Lease lost");
    };
    const request = input();
    await expect(collect(createPrimaryHarnessRuntime(f.options), request)).rejects.toThrow(
      "Lease lost",
    );
    expect(request.executeTool).not.toHaveBeenCalled();
    expect(f.handle.terminate).toHaveBeenCalledTimes(1);
  });

  it("rejects a tool that is not in the current host catalog", async () => {
    const f = fixture(harness, [{ name: "native_shell", args: { command: "denied" } }]);
    const request = input();
    await expect(collect(createPrimaryHarnessRuntime(f.options), request)).rejects.toThrow();
    expect(request.executeTool).not.toHaveBeenCalled();
  });

  it("reuses only its own native checkpoint and retains new group context", async () => {
    const first = fixture(harness);
    const output = await collect(createPrimaryHarnessRuntime(first.options), input());
    const checkpoint = output.findLast((event) => event.type === "checkpoint");
    expect(checkpoint?.type).toBe("checkpoint");
    const second = fixture(harness);
    second.options.nativeCheckpoint = checkpoint?.type === "checkpoint" ? checkpoint.blob : "";
    await collect(createPrimaryHarnessRuntime(second.options), input());
    const payload = JSON.stringify(second.sent);
    expect(payload).toContain("Peer bot Alice");
    expect(payload).toContain(
      harness === "codex"
        ? "thread/resume"
        : harness === "kimi"
          ? "session/resume"
          : "nativeSessionId",
    );
    expect(payload).not.toContain("server-private-route");
  });

  it("rejects another conversation or account checkpoint before spawning", async () => {
    const f = fixture(harness);
    f.options.nativeCheckpoint = JSON.stringify({
      version: 1,
      harness,
      nativeSessionId: nativeId,
      epoch: "epoch",
      profileId: "profile",
      profileRevision: 1,
      accountId: "other-account",
      botId: "bot",
      threadId: "thread",
    });
    await expect(collect(createPrimaryHarnessRuntime(f.options), input())).rejects.toThrow(
      "does not match",
    );
    expect(f.startProcess).not.toHaveBeenCalled();
  });

  it("maps ask_user locally without invoking an unimplemented host control", async () => {
    const f = fixture(harness, [
      { name: "ask_user", args: { question: "Which file?", options: ["One", "Two"] } },
    ]);
    const request = input();
    request.tools = [
      ...tools,
      { name: "ask_user", description: "Ask", inputSchema: { type: "object" } },
    ];
    const result = await collect(createPrimaryHarnessRuntime(f.options), request);
    expect(result).toContainEqual({
      type: "ask",
      text: "Which file?",
      actions: [
        { id: "choice-1", label: "One" },
        { id: "choice-2", label: "Two" },
      ],
    });
    expect(request.executeTool).not.toHaveBeenCalled();
    expect(result.some((event) => event.type === "done")).toBe(false);
  });
});

describe("native primary guardrails", () => {
  it.each(["claude", "codex", "kimi"] as const)(
    "rejects undeclared or malformed %s media before launching a process",
    async (harness) => {
      const f = fixture(harness);
      const request = input();
      request.currentTurnImages = [
        { name: "fake.png", mimeType: "image/png", data: new Uint8Array([1]) },
      ];
      await expect(collect(createPrimaryHarnessRuntime(f.options), request)).rejects.toThrow(
        "not enabled",
      );
      request.model.acceptsImages = true;
      await expect(collect(createPrimaryHarnessRuntime(f.options), request)).rejects.toThrow();
      expect(f.startProcess).not.toHaveBeenCalled();
      expect(request.executeTool).not.toHaveBeenCalled();
    },
  );

  it("fails closed on unsupported provider, protocol, version, account, or computer", () => {
    const f = fixture("claude");
    expect(() =>
      createPrimaryHarnessRuntime({ ...f.options, protocol: "openai-responses" }),
    ).toThrow("protocol");
    expect(() => createPrimaryHarnessRuntime({ ...f.options, runtimeVersion: "latest" })).toThrow(
      "version",
    );
    expect(() => createPrimaryHarnessRuntime({ ...f.options, accountId: "" })).toThrow("account");
    expect(() =>
      createPrimaryHarnessRuntime({ ...f.options, sandbox: {} as SandboxProvider }),
    ).toThrow("isolated");
  });

  it("does not accept OAuth or infer a missing endpoint", async () => {
    const f = fixture("codex");
    const request = input();
    request.model.baseUrl = undefined;
    await expect(collect(createPrimaryHarnessRuntime(f.options), request)).rejects.toThrow(
      "endpoint",
    );
    request.model.baseUrl = "https://example.test/v1";
    request.model.oauth = {
      credential: { type: "oauth", access: "fake", refresh: "fake", expires: 0 },
    };
    await expect(collect(createPrimaryHarnessRuntime(f.options), request)).rejects.toThrow("OAuth");
    expect(f.startProcess).not.toHaveBeenCalled();
  });

  it("cancels a pending native request and terminates the process tree", async () => {
    const f = fixture("claude");
    vi.mocked(f.handle.writeStdin).mockResolvedValue(undefined);
    const runtime = createPrimaryHarnessRuntime(f.options);
    const pending = collect(runtime, input());
    await vi.waitFor(() => expect(f.startProcess).toHaveBeenCalledTimes(1));
    await runtime.abort("run");
    await expect(pending).rejects.toThrow();
    expect(f.handle.terminate).toHaveBeenCalledTimes(1);
  });
});

describe("mediated helper runtime integration", () => {
  it.each<PrimaryHarness>(["claude", "codex", "kimi"])(
    "%s keeps helper effects authorized and accounts helper usage exactly once",
    async (harness) => {
      const parent = fixture(harness, [
        { name: "run_subagent", args: { name: "reader", task: "Read the note." } },
      ]);
      const child = fixture(harness, [{ name: "read_file", args: { path: "note.md" } }]);
      const startProcess = vi
        .fn()
        .mockResolvedValueOnce(parent.handle)
        .mockResolvedValueOnce(child.handle);
      parent.options.sandbox = { startProcess } as unknown as SandboxProvider;
      const saved: string[] = [];
      parent.options.onCheckpoint = async (blob) => {
        saved.push(blob);
      };
      const request = input();
      request.tools = [
        ...tools,
        {
          name: "run_subagent",
          description: "Delegate a narrow task.",
          inputSchema: { type: "object" },
        },
      ];
      const usage: AgentRuntimeEvent[] = [];
      request.onUsage = async (event) => {
        usage.push(event);
      };
      request.executeTool = vi.fn(async (name) => {
        expect(name).toBe("read_file");
        const latest = JSON.parse(saved.at(-1)!);
        expect(
          Object.values(latest.helpers).some((state) =>
            Boolean((state as { checkpoint?: string }).checkpoint),
          ),
        ).toBe(true);
        return "blue";
      });
      const result = await collect(createPrimaryHarnessRuntime(parent.options), request);
      expect(result.at(-1)).toEqual({ type: "done" });
      expect(startProcess).toHaveBeenCalledTimes(2);
      expect(startProcess.mock.calls[0]?.[1].sessionScope.epoch).not.toBe(
        startProcess.mock.calls[1]?.[1].sessionScope.epoch,
      );
      expect(request.executeTool).toHaveBeenCalledTimes(1);
      expect(
        result.some((event) => event.type === "subagent" && event.status === "completed"),
      ).toBe(true);
      const childUsage = usage.filter(
        (event) => event.type === "usage" && event.operationKind === "subagent",
      );
      // Per-call measurements are accounted once even through a helper.
      expect(childUsage).toHaveLength(1);
      expect(
        result.filter((event) => event.type === "usage" && event.operationKind === "subagent"),
      ).toEqual(childUsage.map((event) => ({ ...event, accounted: true })));
    },
  );
});

describe("native helper approval continuation", () => {
  it.each<PrimaryHarness>(["claude", "codex", "kimi"])(
    "%s persists a paused helper and resumes its native session through the same run",
    async (harness) => {
      const helperCall = {
        name: "run_subagent",
        args: { name: "writer", task: "Update the note." },
      };
      const request = input();
      request.tools = [
        ...tools,
        { name: "run_subagent", description: "Delegate.", inputSchema: { type: "object" } },
      ];
      let checkpoint = "";
      const paused = fixture(harness, [helperCall]);
      const pausedChild = fixture(harness, [{ name: "write_file", args: { path: "note.md" } }]);
      const firstStart = vi
        .fn()
        .mockResolvedValueOnce(paused.handle)
        .mockResolvedValueOnce(pausedChild.handle);
      paused.options.sandbox = { startProcess: firstStart } as unknown as SandboxProvider;
      paused.options.onCheckpoint = async (blob) => {
        checkpoint = blob;
      };
      request.executeTool = vi.fn(async () => approvalPausedToolResult());
      const first = await collect(createPrimaryHarnessRuntime(paused.options), request);
      expect(first.some((event) => event.type === "done")).toBe(false);
      const parentState = JSON.parse(checkpoint);
      const state = Object.values(parentState.helpers)[0] as {
        checkpoint: string;
        result?: string;
      };
      expect(state.result).toBeUndefined();
      expect(state.checkpoint).toBeTruthy();
      const childState = JSON.parse(state.checkpoint);
      const resumed = fixture(harness, [helperCall]);
      const resumedChild = fixture(harness, [{ name: "write_file", args: { path: "note.md" } }]);
      const secondStart = vi
        .fn()
        .mockResolvedValueOnce(resumed.handle)
        .mockResolvedValueOnce(resumedChild.handle);
      resumed.options = {
        ...resumed.options,
        nativeCheckpoint: checkpoint,
        onCheckpoint: async (blob) => {
          checkpoint = blob;
        },
        sandbox: { startProcess: secondStart } as unknown as SandboxProvider,
      };
      request.executeTool = vi.fn(async () => "approved and saved");
      const result = await collect(createPrimaryHarnessRuntime(resumed.options), request);
      expect(result.at(-1)).toEqual({ type: "done" });
      expect(request.executeTool).toHaveBeenCalledTimes(1);
      expect(secondStart.mock.calls[1]?.[1].sessionScope).toEqual(
        firstStart.mock.calls[1]?.[1].sessionScope,
      );
      const resumeMessage = resumedChild.sent.find(
        (message) =>
          message.method ===
          (harness === "codex"
            ? "thread/resume"
            : harness === "kimi"
              ? "session/resume"
              : "rakazo/start"),
      );
      expect(resumeMessage?.params).toMatchObject(
        harness === "codex"
          ? { threadId: childState.nativeSessionId }
          : harness === "kimi"
            ? { sessionId: childState.nativeSessionId }
            : { nativeSessionId: childState.nativeSessionId },
      );
      const completed = Object.values(JSON.parse(checkpoint).helpers)[0] as { result?: string };
      expect(completed.result).toBe("Verified.");
    },
  );
});

describe("native managed account runtime boundary", () => {
  function native(harness: "codex" | "kimi", calls: ToolCall[] = []) {
    const f = fixture(harness, calls);
    f.options.nativeLogin = true;
    f.options.computer.id = f.options.computer.providerRef;
    f.options.sandbox.nativeStateInstallationId = () => "a".repeat(32);
    const request = input();
    request.model.apiKey = undefined;
    request.model.nativeLogin = {
      kind: "native_login",
      harness,
      installationId: "a".repeat(32),
      connectionId: "11111111-1111-4111-8111-111111111111",
      epoch: "22222222-2222-4222-8222-222222222222",
      computerId: "db-computer",
      computerProviderRef: f.options.computer.providerRef,
      computerHomeKey: f.options.computer.botId,
      spaceId: f.options.context.spaceId,
      region: "global",
      state: "ready",
    };
    request.model.provider = `native-${harness}`;
    request.model.baseUrl = nativeLoginEndpoint(request.model.nativeLogin);
    request.tools = [
      ...request.tools,
      {
        name: "run_subagent",
        description: "Delegate",
        inputSchema: { type: "object", properties: {} },
      },
    ];
    return { ...f, request };
  }
  it.each(["codex", "kimi"] as const)(
    "%s uses only the scoped private account and binds native checkpoints",
    async (harness) => {
      const f = native(harness, [{ name: "read_file", args: { path: "note.md" } }]);
      const runtime = createPrimaryHarnessRuntime(f.options);
      expect(runtime.describe().capabilities.delegatedAgents).toBe(false);
      const output = await collect(runtime, f.request);
      expect(output.at(-1)?.type).toBe("done");
      const launch = f.startProcess.mock.calls[0]?.[1];
      expect(launch?.env).toEqual({});
      expect(launch?.credentialScope).toEqual({
        harness,
        connectionId: f.request.model.nativeLogin?.connectionId,
        epoch: f.request.model.nativeLogin?.epoch,
      });
      expect(f.sent.some((frame) => JSON.stringify(frame).includes('"name":"run_subagent"'))).toBe(
        false,
      );
      const checkpoint = output.find((event) => event.type === "checkpoint");
      expect(checkpoint?.type).toBe("checkpoint");
      if (checkpoint?.type === "checkpoint")
        expect(JSON.parse(checkpoint.blob).credentialEpoch).toBe(
          f.request.model.nativeLogin?.epoch,
        );
    },
  );
  it("rejects forged helpers rather than sharing native refresh credentials", async () => {
    const f = native("codex", [{ name: "run_subagent", args: { task: "do work" } }]);
    await expect(collect(createPrimaryHarnessRuntime(f.options), f.request)).rejects.toThrow(
      "Helpers are unavailable with native sign-in",
    );
    expect(f.startProcess).toHaveBeenCalledTimes(1);
    expect(f.request.executeTool).not.toHaveBeenCalled();
  });
  it.each(["endpoint", "api-key", "provider", "installation", "computer", "state", "mode"])(
    "rejects changed %s before launching",
    async (kind) => {
      const f = native("codex");
      if (kind === "endpoint") f.request.model.baseUrl = "https://example.invalid/v1";
      if (kind === "api-key") f.request.model.apiKey = "fake-forbidden-overlay";
      if (kind === "provider") f.request.model.provider = "openai";
      if (kind === "installation") f.request.model.nativeLogin!.installationId = "b".repeat(32);
      if (kind === "computer") f.request.model.nativeLogin!.computerProviderRef = "another";
      if (kind === "state") f.request.model.nativeLogin!.state = "pending";
      if (kind === "mode") f.options.nativeLogin = false;
      await expect(collect(createPrimaryHarnessRuntime(f.options), f.request)).rejects.toThrow();
      expect(f.startProcess).not.toHaveBeenCalled();
    },
  );
});
