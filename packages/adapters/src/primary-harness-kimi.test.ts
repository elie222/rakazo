import type { AgentInputImage, AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import {
  buildKimiProcess,
  KIMI_CLI_VERSION,
  KIMI_SANDBOX_RUNNER,
  runKimiProtocol,
} from "./primary-harness-kimi.js";
import type { NativeProtocolChannel, NativeProtocolContext } from "./primary-harness-protocol.js";
import { NativeHarnessPaused } from "./primary-harness-protocol.js";

const SESSION = "kimi-native-session-1";
const PROMPT = "rakazo:kimi:prompt";
const tool = {
  name: "read_note",
  description: "Read a note",
  inputSchema: {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
  },
  route: { connectorId: "private-route", toolName: "read" },
};

function request(): AgentRunRequest {
  return {
    botId: "bot",
    threadId: "thread",
    runId: "run",
    sourceMessageId: "current-message",
    prompt: "Read the note",
    instructions: "Use the provided tools. $" + "{cwd} `literal` {% literal %}",
    history: [],
    tools: [tool],
    model: {
      provider: "openai-compatible",
      id: "example-model",
      apiKey: "fake-test-key",
      baseUrl: "https://model.example.test/v1",
      contextWindow: 128_000,
    },
  };
}

function update(update: Record<string, unknown>, sessionId = SESSION) {
  return { method: "session/update", params: { sessionId, update } };
}

function text(text: string) {
  return update({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text },
  });
}

function toolStarted(name = "mcp__rakazo__read_note", toolCallId = "0:call-1") {
  return update({
    sessionUpdate: "tool_call",
    toolCallId,
    title: name,
    status: "pending",
  });
}

function permission(
  name = "mcp__rakazo__read_note",
  toolCallId = "0:call-1",
  options = [{ optionId: "approve_once", kind: "allow_once", name: "Approve once" }],
) {
  return {
    id: "permission-1",
    method: "session/request_permission",
    params: {
      sessionId: SESSION,
      toolCall: { toolCallId, title: name },
      options,
    },
  };
}

function externalTool() {
  return {
    id: "host-tool-1",
    method: "rakazo/tool",
    params: { name: "read_note", args: { name: "a" }, callId: "kimi-tool-1" },
  };
}

function usage(callId: string, values: Record<string, unknown> = {}) {
  return {
    method: "rakazo/usage",
    params: {
      type: "usage.record",
      agentId: "main",
      model: "rakazo",
      usageScope: "turn",
      callId,
      usage: {
        inputOther: 20,
        output: 10,
        inputCacheRead: 8,
        inputCacheCreation: 2,
        ...values,
      },
    },
  };
}

function finished(stopReason = "end_turn", verifiedReason = "completed") {
  return { id: PROMPT, result: { stopReason, verifiedReason } };
}

function fixture(frames: Record<string, unknown>[] = [finished()]) {
  const events: AgentRuntimeEvent[] = [];
  const startup = { version: KIMI_CLI_VERSION };
  const initialized = {
    protocolVersion: 1,
    agentInfo: { name: "Kimi Code", version: KIMI_CLI_VERSION },
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: true, audio: false },
    },
  };
  const session = { sessionId: SESSION };
  const send = vi.fn<NativeProtocolChannel["send"]>().mockResolvedValue(undefined);
  const rpc = vi.fn<NativeProtocolChannel["request"]>().mockImplementation(async (method) => {
    if (method === "rakazo/start") return startup;
    if (method === "initialize") return initialized;
    if (method === "session/new") return session;
    if (method === "session/resume")
      return { configOptions: [], modes: { currentModeId: "default" } };
    throw new Error(`Unexpected request: ${method}`);
  });
  const channel: NativeProtocolChannel = {
    send,
    request: rpc,
    messages: (async function* () {
      yield* frames;
    })(),
  };
  const controller = new AbortController();
  const callTool = vi
    .fn<NativeProtocolContext["callTool"]>()
    .mockResolvedValue({ text: '{"note":"A note"}', isError: false });
  const context: NativeProtocolContext = {
    request: request(),
    tools: [tool],
    prompt: "/reset\nRead the note",
    signal: controller.signal,
    emit: (value) => events.push(value),
    callTool,
    setInterrupt: vi.fn(),
    onSession: vi.fn(),
  };
  return {
    channel,
    context,
    events,
    send,
    rpc,
    startup,
    initialized,
    session,
    controller,
    callTool,
  };
}

async function picture(name: string): Promise<AgentInputImage> {
  return {
    name,
    mimeType: "image/png",
    data: await sharp({
      create: { width: 1, height: 1, channels: 3, background: "red" },
    })
      .png()
      .toBuffer(),
  };
}

describe("Kimi Code isolated process", () => {
  it("pins the official successor CLI and passes credentials only in the sandbox environment", () => {
    const input = request();
    const process = buildKimiProcess(input);
    expect(KIMI_CLI_VERSION).toBe("2.2.0");
    expect(process.isolation).toBe("primary-harness");
    expect(process.argv).toEqual(["node", "--input-type=module", "--eval", KIMI_SANDBOX_RUNNER]);
    expect(process.env).toEqual({ KIMI_API_KEY: "fake-test-key" });
    expect(KIMI_SANDBOX_RUNNER).not.toContain(input.model.apiKey);
    expect(KIMI_SANDBOX_RUNNER).not.toContain(input.instructions);
    expect(KIMI_SANDBOX_RUNNER).not.toContain(input.prompt);
    expect(KIMI_SANDBOX_RUNNER).toContain("@moonshot-ai/kimi-code");
    expect(KIMI_SANDBOX_RUNNER).toContain("version!=='2.2.0'");
    expect(KIMI_SANDBOX_RUNNER).toContain("api_key_env");
    expect(KIMI_SANDBOX_RUNNER).toContain("telemetry = false");
    expect(KIMI_SANDBOX_RUNNER).toContain("mcp__rakazo__");
    expect(KIMI_SANDBOX_RUNNER).toContain("subagents: []");
    expect(KIMI_SANDBOX_RUNNER).toContain("symlinkSync(sessions,state+'/sessions')");
    expect(KIMI_SANDBOX_RUNNER).toContain("/sessions/kimi-code-sessions");
    expect(KIMI_SANDBOX_RUNNER).toContain("await rpc('session/close'");
    expect(KIMI_SANDBOX_RUNNER).toContain("entry.type==='turn.ended'");
    expect(KIMI_SANDBOX_RUNNER).toContain("entry.type==='usage.record'");
    expect(KIMI_SANDBOX_RUNNER).not.toContain("kimi_cli");
  });

  it("requires explicit API-key authentication and an endpoint", () => {
    const input = request();
    delete input.model.apiKey;
    expect(() => buildKimiProcess(input)).toThrow("explicit API key");
    input.model.apiKey = "fake-test-key";
    input.model.oauth = { credential: {} as never };
    expect(() => buildKimiProcess(input)).toThrow("OAuth");
    delete input.model.oauth;
    delete input.model.baseUrl;
    expect(() => buildKimiProcess(input)).toThrow("endpoint");
  });
});

describe("Kimi Code ACP protocol", () => {
  it("initializes a private external-tool bridge without exposing routes, secrets, or slash commands", async () => {
    const f = fixture();
    await runKimiProtocol(f.channel, f.context);
    expect(f.rpc).toHaveBeenNthCalledWith(1, "rakazo/start", {
      instructions: f.context.request.instructions,
      modelId: "example-model",
      endpoint: "https://model.example.test/v1",
      nativeLogin: false,
      region: undefined,
      contextWindow: 128_000,
      images: false,
      tools: [
        {
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        },
      ],
    });
    expect(f.rpc).toHaveBeenNthCalledWith(2, "initialize", {
      protocolVersion: 1,
      clientInfo: { name: "rakazo", version: "1.0.0" },
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    });
    expect(f.rpc).toHaveBeenNthCalledWith(3, "session/new", {
      cwd: "/home/harness",
      mcpServers: [],
    });
    expect(JSON.stringify(f.rpc.mock.calls)).not.toContain("private-route");
    expect(JSON.stringify(f.rpc.mock.calls)).not.toContain("fake-test-key");
    expect(f.send).toHaveBeenCalledWith({
      id: PROMPT,
      method: "session/prompt",
      params: {
        sessionId: SESSION,
        prompt: [
          {
            type: "text",
            text: "Rakazo conversation input:\n/reset\nRead the note",
          },
        ],
      },
    });
  });

  it("waits for checkpoint persistence before sending the native prompt", async () => {
    const f = fixture();
    let persist!: () => void;
    f.context.onSession = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          persist = resolve;
        }),
    );
    const running = runKimiProtocol(f.channel, f.context);
    await vi.waitFor(() => expect(f.context.onSession).toHaveBeenCalledExactlyOnceWith(SESSION));
    expect(f.send).not.toHaveBeenCalled();
    persist();
    await running;
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it("resumes the stored native identifier even when the ACP response has no sessionId", async () => {
    const f = fixture();
    f.context.nativeSessionId = "stored-native-session";
    await runKimiProtocol(f.channel, f.context);
    expect(f.rpc).toHaveBeenNthCalledWith(3, "session/resume", {
      sessionId: "stored-native-session",
      cwd: "/home/harness",
      mcpServers: [],
    });
    expect(f.context.onSession).toHaveBeenCalledExactlyOnceWith("stored-native-session");
    expect(f.send.mock.calls[0]?.[0]).toMatchObject({
      params: { sessionId: "stored-native-session" },
    });
  });

  it.each(["../../other-session", "", "x".repeat(129)])(
    "rejects unsafe session IDs: %j",
    async (id) => {
      const f = fixture();
      if (id) f.context.nativeSessionId = id;
      else f.session.sessionId = id;
      await expect(runKimiProtocol(f.channel, f.context)).rejects.toThrow();
      expect(f.send).not.toHaveBeenCalled();
    },
  );

  it("does not prompt if checkpoint persistence fails", async () => {
    const f = fixture();
    f.context.onSession = vi.fn().mockRejectedValue(new Error("checkpoint failed"));
    await expect(runKimiProtocol(f.channel, f.context)).rejects.toThrow("checkpoint failed");
    expect(f.send).not.toHaveBeenCalled();
  });

  it("streams only public text and real per-call wire usage, never ACP context occupancy", async () => {
    const f = fixture([
      update({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Private reasoning" },
      }),
      text("Looking. "),
      update({ sessionUpdate: "usage_update", used: 12000, size: 128000 }),
      usage(`${SESSION}:wire:12`),
      externalTool(),
      usage(`${SESSION}:wire:26`, {
        inputOther: 3,
        output: 4,
        inputCacheRead: 1,
        inputCacheCreation: 0,
      }),
      text("Found it."),
      finished(),
    ]);
    await runKimiProtocol(f.channel, f.context);
    expect(f.callTool).toHaveBeenCalledExactlyOnceWith("read_note", { name: "a" }, "kimi-tool-1");
    expect(f.events).toEqual([
      { type: "text", text: "Looking. " },
      expect.objectContaining({
        type: "usage",
        provider: "openai-compatible",
        model: "example-model",
        callId: `${SESSION}:wire:12`,
        inputTokens: 20,
        outputTokens: 10,
        cacheReadTokens: 8,
        cacheWriteTokens: 2,
        totalTokens: 40,
        usageSource: "kimi-code-wire",
      }),
      expect.objectContaining({
        type: "usage",
        callId: `${SESSION}:wire:26`,
        inputTokens: 3,
        outputTokens: 4,
        cacheReadTokens: 1,
        cacheWriteTokens: 0,
        totalTokens: 8,
      }),
      { type: "text", text: "Found it." },
    ]);
    expect(f.send).toHaveBeenCalledWith({
      id: "host-tool-1",
      result: { text: '{"note":"A note"}', isError: false },
    });
  });

  it.each([-1, 1.5, "12", null, undefined, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid measured token counts: %j",
    async (inputOther) => {
      const f = fixture([usage("bad", { inputOther }), finished()]);
      await expect(runKimiProtocol(f.channel, f.context)).rejects.toThrow("invalid token usage");
      expect(f.events).toEqual([]);
    },
  );

  it("does not invent token measurements from context occupancy", async () => {
    const f = fixture([
      update({ sessionUpdate: "usage_update", used: 300, size: 128000 }),
      finished(),
    ]);
    await runKimiProtocol(f.channel, f.context);
    expect(f.events).toEqual([
      expect.objectContaining({
        type: "usage",
        callId: `${SESSION}:run:usage-unavailable`,
        inputTokens: null,
        outputTokens: null,
        usageSource: "kimi-code-usage-unavailable",
      }),
    ]);
  });

  it("treats upstream synthetic all-zero usage as unknown rather than measured zero", async () => {
    const f = fixture([
      usage(`${SESSION}:wire:12`, {
        inputOther: 0,
        output: 0,
        inputCacheRead: 0,
        inputCacheCreation: 0,
      }),
      finished(),
    ]);
    await runKimiProtocol(f.channel, f.context);
    expect(f.events).toEqual([
      expect.objectContaining({
        type: "usage",
        callId: `${SESSION}:wire:12`,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        totalTokens: null,
        usageSource: "kimi-code-usage-unavailable",
      }),
    ]);
  });

  it("does not charge twice when a persisted usage record is delivered again", async () => {
    const record = usage(`${SESSION}:wire:12`);
    const f = fixture([record, record, finished()]);
    await runKimiProtocol(f.channel, f.context);
    expect(f.events).toHaveLength(1);
    expect(f.events[0]).toMatchObject({
      type: "usage",
      callId: `${SESSION}:wire:12`,
    });
  });

  it.each([
    ["end_turn", "failed"],
    ["end_turn", "blocked"],
    ["end_turn", "missing"],
    ["end_turn", "cancelled"],
    ["cancelled", "completed"],
    ["refusal", "completed"],
    ["max_tokens", "completed"],
    ["unknown", "completed"],
  ])("does not accept ACP %s without durable completed outcome %s", async (stop, verified) => {
    const f = fixture([finished(stop, verified)]);
    await expect(runKimiProtocol(f.channel, f.context)).rejects.toThrow(
      "did not complete successfully",
    );
  });

  it("requires a verified prompt response rather than text, context updates, or EOF", async () => {
    const f = fixture([
      text("partial"),
      update({ sessionUpdate: "usage_update", used: 3, size: 10 }),
    ]);
    await expect(runKimiProtocol(f.channel, f.context)).rejects.toThrow("verified terminal result");
    expect(f.events).toEqual([{ type: "text", text: "partial" }]);
  });

  it("does not expose upstream error bodies", async () => {
    const f = fixture([
      {
        id: PROMPT,
        error: { code: 123, message: "fake-sensitive-error-body" },
      },
    ]);
    await expect(runKimiProtocol(f.channel, f.context)).rejects.toThrow(
      /^Kimi Code did not complete successfully$/,
    );
  });

  it.each(["package", "protocol", "agent"])(
    "rejects an unsupported %s version before prompting",
    async (kind) => {
      const f = fixture();
      if (kind === "package") f.startup.version = "1.51.0";
      if (kind === "protocol") f.initialized.protocolVersion = 2;
      if (kind === "agent") f.initialized.agentInfo.version = "2.2.1";
      await expect(runKimiProtocol(f.channel, f.context)).rejects.toThrow("Unsupported");
      expect(f.send).not.toHaveBeenCalled();
    },
  );

  it("rejects cross-session notifications", async () => {
    const f = fixture([
      update({ sessionUpdate: "agent_message_chunk" }, "another-session"),
      finished(),
    ]);
    await expect(runKimiProtocol(f.channel, f.context)).rejects.toThrow(
      "session identity mismatch",
    );
  });

  it("permits only one-shot dispatch for an already announced exact bridge tool", async () => {
    const f = fixture([toolStarted(), permission(), externalTool(), finished()]);
    await runKimiProtocol(f.channel, f.context);
    expect(f.send).toHaveBeenCalledWith({
      id: "permission-1",
      result: { outcome: { outcome: "selected", optionId: "approve_once" } },
    });
    expect(f.callTool).toHaveBeenCalledExactlyOnceWith("read_note", { name: "a" }, "kimi-tool-1");
  });

  it("cannot reuse the same bridge permission to approve another dispatch", async () => {
    const f = fixture([toolStarted(), permission(), permission(), finished()]);
    await expect(runKimiProtocol(f.channel, f.context)).rejects.toThrow();
    expect(f.send).toHaveBeenLastCalledWith({
      id: "permission-1",
      result: { outcome: { outcome: "cancelled" } },
    });
    expect(f.callTool).not.toHaveBeenCalled();
  });

  it("retains hyphens and normalizes repeated underscores in qualified bridge names", async () => {
    const name = "read__a-note";
    const qualified = "mcp__rakazo__read_a-note";
    const f = fixture([toolStarted(qualified), permission(qualified), finished()]);
    f.context.tools = [{ ...tool, name }];
    await runKimiProtocol(f.channel, f.context);
    expect(f.send).toHaveBeenLastCalledWith({
      id: "permission-1",
      result: { outcome: { outcome: "selected", optionId: "approve_once" } },
    });
  });

  it("denies a bridge permission from another session", async () => {
    const p = permission();
    p.params.sessionId = "another-session";
    const f = fixture([toolStarted(), p, finished()]);
    await expect(runKimiProtocol(f.channel, f.context)).rejects.toThrow();
    expect(f.send).toHaveBeenLastCalledWith({
      id: "permission-1",
      result: { outcome: { outcome: "cancelled" } },
    });
  });

  it.each([
    [permission()],
    [toolStarted(), permission("mcp__rakazo__write_note")],
    [toolStarted(), permission("mcp__rakazo__read_note", "another-call")],
    [
      toolStarted(),
      permission("mcp__rakazo__read_note", "0:call-1", [
        { optionId: "approve_always", kind: "allow_always", name: "Always" },
      ]),
    ],
    [
      toolStarted(),
      permission("mcp__rakazo__read_note", "0:call-1", [
        { optionId: "approve_once", kind: "allow_always", name: "Always" },
      ]),
    ],
  ])("denies native, uncorrelated, and persistent approvals: %j", async (...frames) => {
    const f = fixture([...frames, finished()]);
    await expect(runKimiProtocol(f.channel, f.context)).rejects.toThrow();
    expect(f.callTool).not.toHaveBeenCalled();
    expect(f.send).toHaveBeenLastCalledWith({
      id: "permission-1",
      result: { outcome: { outcome: "cancelled" } },
    });
  });

  it("stops immediately when the native engine announces a built-in tool", async () => {
    const f = fixture([toolStarted("Bash"), permission("Bash"), finished()]);
    await expect(runKimiProtocol(f.channel, f.context)).rejects.toThrow();
    expect(f.callTool).not.toHaveBeenCalled();
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it.each(["fs/read_text_file", "fs/write_text_file", "terminal/create", "unknown/request"])(
    "rejects unexpected reverse RPC %s",
    async (method) => {
      const f = fixture([{ id: "native-request", method, params: {} }, finished()]);
      await expect(runKimiProtocol(f.channel, f.context)).rejects.toThrow(
        "unsupported native action",
      );
      expect(f.callTool).not.toHaveBeenCalled();
      expect(f.send).toHaveBeenLastCalledWith({
        id: "native-request",
        error: { code: -32601, message: "Native actions are disabled" },
      });
    },
  );

  it("propagates host approval pauses without returning a successful tool result", async () => {
    const f = fixture([externalTool(), finished()]);
    const pause = new NativeHarnessPaused();
    f.callTool.mockRejectedValue(pause);
    await expect(runKimiProtocol(f.channel, f.context)).rejects.toBe(pause);
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it("cancels through ACP and does not deliver a tool result after abort", async () => {
    const f = fixture([externalTool(), finished()]);
    let interrupt: (() => Promise<void>) | undefined;
    f.context.setInterrupt = (value) => {
      interrupt = value;
    };
    f.callTool.mockImplementation(async () => {
      await interrupt?.();
      f.controller.abort();
      return { text: "not delivered", isError: false };
    });
    await expect(runKimiProtocol(f.channel, f.context)).rejects.toThrow();
    expect(f.send).toHaveBeenLastCalledWith({ method: "rakazo/interrupt" });
    expect(f.send).toHaveBeenCalledTimes(2);
  });

  it("does no work for an already cancelled turn", async () => {
    const f = fixture();
    f.controller.abort();
    await expect(runKimiProtocol(f.channel, f.context)).rejects.toThrow();
    expect(f.rpc).not.toHaveBeenCalled();
  });
});

describe("Kimi Code native media", () => {
  it("sends current and historical images as original ACP image blocks with attribution", async () => {
    const f = fixture();
    const prior = await picture("prior.png");
    const current = await picture("../../current.png");
    f.context.request.model.acceptsImages = true;
    f.context.request.history = [
      {
        id: "prior-message",
        role: "assistant",
        content: "Prior result",
        images: [prior],
      },
    ];
    f.context.request.currentTurnImages = [current];
    await runKimiProtocol(f.channel, f.context);
    const params = f.send.mock.calls[0]?.[0].params as {
      prompt: Record<string, unknown>[];
    };
    expect(params.prompt).toHaveLength(5);
    expect(JSON.parse(String(params.prompt[1]?.text))).toMatchObject({
      source: "history",
      messageId: "prior-message",
      role: "assistant",
      name: "prior.png",
    });
    expect(params.prompt[2]).toEqual({
      type: "image",
      data: Buffer.from(prior.data).toString("base64"),
      mimeType: "image/png",
    });
    expect(JSON.parse(String(params.prompt[3]?.text))).toMatchObject({
      source: "current",
      messageId: "current-message",
      name: "../../current.png",
    });
    expect(params.prompt[4]).toEqual({
      type: "image",
      data: Buffer.from(current.data).toString("base64"),
      mimeType: "image/png",
    });
  });

  it("preserves validated image content returned by host tools", async () => {
    const f = fixture([externalTool(), finished()]);
    const image = await picture("result.png");
    const content = [
      {
        type: "image" as const,
        mimeType: "image/png" as const,
        data: Buffer.from(image.data).toString("base64"),
      },
    ];
    f.callTool.mockResolvedValue({
      text: "Image result",
      isError: false,
      content,
    });
    await runKimiProtocol(f.channel, f.context);
    expect(f.send).toHaveBeenCalledWith({
      id: "host-tool-1",
      result: { text: "Image result", isError: false, content },
    });
  });

  it.each(["current", "history"])(
    "rejects raw %s audio before starting, without a transcription fallback",
    async (source) => {
      const f = fixture();
      f.context.request.model.acceptsAudio = true;
      const audio = {
        name: "original.wav",
        mimeType: "audio/wav" as const,
        data: new Uint8Array([1, 2]),
      };
      if (source === "current") f.context.request.currentTurnAudio = [audio];
      else f.context.request.history = [{ role: "user", content: "Audio", audio: [audio] }];
      await expect(runKimiProtocol(f.channel, f.context)).rejects.toThrow(
        "transcription is not substituted",
      );
      expect(f.rpc).not.toHaveBeenCalled();
      expect(f.send).not.toHaveBeenCalled();
    },
  );

  it("requires an explicit image-capable model before starting", async () => {
    const f = fixture();
    f.context.request.currentTurnImages = [await picture("image.png")];
    await expect(runKimiProtocol(f.channel, f.context)).rejects.toThrow("not enabled");
    expect(f.rpc).not.toHaveBeenCalled();
  });
  it("explains the known media-stripping refusal without exposing upstream text", async () => {
    const f = fixture([
      {
        method: "rakazo/failure",
        params: { code: "media_stripped", message: "private-upstream-error" },
      },
    ]);
    await expect(runKimiProtocol(f.channel, f.context)).rejects.toThrow(
      "Kimi attempted to remove attached media after a provider error; the run was stopped.",
    );
  });
  it("does not expose arbitrary native failure codes or upstream exception text", async () => {
    const f = fixture([
      {
        method: "rakazo/failure",
        params: { code: "private-upstream-code", message: "private-upstream-error" },
      },
    ]);
    await expect(runKimiProtocol(f.channel, f.context)).rejects.toThrow(
      /^Kimi Code protocol failed$/,
    );
  });
});
