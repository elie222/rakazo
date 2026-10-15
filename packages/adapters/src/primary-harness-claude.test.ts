import { runInNewContext } from "node:vm";
import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import {
  buildClaudeProcess,
  CLAUDE_SANDBOX_RUNNER,
  runClaudeProtocol,
} from "./primary-harness-claude.js";
import type { NativeProtocolContext } from "./primary-harness-protocol.js";

function setup(messages: Record<string, unknown>[], nativeSessionId?: string) {
  const output: AgentRuntimeEvent[] = [];
  const context: NativeProtocolContext = {
    request: {
      runId: "run",
      botId: "bot",
      threadId: "thread",
      prompt: "Do work.",
      tools: [],
      instructions: "Safe bridge only.",
      history: [],
      model: { provider: "anthropic", id: "claude" },
    } satisfies AgentRunRequest,
    tools: [],
    prompt: "Do work.",
    nativeSessionId,
    signal: new AbortController().signal,
    emit: (event) => output.push(event),
    onSession: vi.fn(async () => undefined),
    setInterrupt: vi.fn(),
    callTool: vi.fn(async () => ({ text: "ok", isError: false })),
  };
  const send = vi.fn(async () => undefined);
  const channel = {
    request: vi.fn(async () => ({ version: "0.3.300" })),
    send,
    messages: {
      async *[Symbol.asyncIterator]() {
        yield* messages;
      },
    },
  };
  return { context, channel, output, send };
}
const stream = (event: Record<string, unknown>) => ({
  method: "rakazo/sdk",
  params: { type: "stream_event", event },
});
const result = (extra: Record<string, unknown> = {}) => ({
  method: "rakazo/sdk",
  params: { type: "result", subtype: "success", is_error: false, uuid: "result-id", ...extra },
});
const step = (id: string) => [
  stream({
    type: "message_start",
    message: {
      id,
      model: "claude",
      usage: {
        input_tokens: 30,
        output_tokens: 1,
        cache_read_input_tokens: 4,
        cache_creation_input_tokens: 0,
      },
    },
  }),
  stream({ type: "message_delta", usage: { output_tokens: 12 } }),
  stream({ type: "message_stop" }),
];

describe("Claude native usage and protocol", () => {
  it("accounts completed stream usage before tool effects, deduplicates provider message IDs, and ignores cumulative result totals", async () => {
    const f = setup(
      [
        ...step("msg1"),
        ...step("msg1"),
        {
          id: "tool",
          method: "rakazo/tool",
          params: { name: "read_file", args: {}, callId: "call" },
        },
        result({ modelUsage: { claude: { inputTokens: 9000, outputTokens: 8000 } } }),
      ],
      "resumed-session",
    );
    f.context.callTool = vi.fn(async () => {
      expect(f.output.filter((event) => event.type === "usage")).toHaveLength(1);
      return { text: "ok", isError: false };
    });
    await runClaudeProtocol(f.channel, f.context);
    expect(f.output.filter((event) => event.type === "usage")).toEqual([
      expect.objectContaining({
        callId: "run:claude:msg1",
        inputTokens: 30,
        outputTokens: 12,
        cacheReadTokens: 4,
        cacheWriteTokens: 0,
        costUsd: null,
      }),
    ]);
  });
  it("uses per-turn result.usage fallback rather than restored session modelUsage", async () => {
    const f = setup(
      [
        result({
          usage: { input_tokens: 10, output_tokens: 5 },
          modelUsage: { claude: { inputTokens: 1000, outputTokens: 500 } },
        }),
      ],
      "resumed-session",
    );
    await runClaudeProtocol(f.channel, f.context);
    expect(f.output).toEqual([
      expect.objectContaining({
        inputTokens: 10,
        outputTokens: 5,
        costUsd: null,
        callId: "run:claude:result-id",
      }),
    ]);
  });
  it("never uses the assistant output placeholder when the final stream count is unavailable", async () => {
    const f = setup([
      stream({
        type: "message_start",
        message: { id: "partial", model: "claude", usage: { input_tokens: 30, output_tokens: 1 } },
      }),
      stream({ type: "message_stop" }),
      result(),
    ]);
    await runClaudeProtocol(f.channel, f.context);
    expect(f.output).toEqual([
      expect.objectContaining({ inputTokens: 30, outputTokens: null, costUsd: null }),
    ]);
  });
  it("rejects unknown security requests and failed terminal results", async () => {
    const unknown = setup([{ id: "permission", method: "permission/allow", params: {} }]);
    await expect(runClaudeProtocol(unknown.channel, unknown.context)).rejects.toThrow(
      "unsupported operation",
    );
    expect(unknown.send).toHaveBeenCalledWith({
      id: "permission",
      error: { code: -32601, message: "Request denied." },
    });
    const failed = setup([result({ subtype: "error_during_execution", is_error: true })]);
    await expect(runClaudeProtocol(failed.channel, failed.context)).rejects.toThrow("successfully");
  });
});

describe("Claude inline media bridge", () => {
  it("preserves image bytes and authorized image tool content", async () => {
    const data = await sharp({ create: { width: 2, height: 2, channels: 3, background: "white" } })
      .png()
      .toBuffer();
    const f = setup([
      {
        id: "tool",
        method: "rakazo/tool",
        params: { name: "read_file", args: {}, callId: "call" },
      },
      result(),
    ]);
    f.context.request.model.acceptsImages = true;
    f.context.request.currentTurnImages = [{ name: "image.png", mimeType: "image/png", data }];
    const content = [
      { type: "image" as const, mimeType: "image/png" as const, data: data.toString("base64") },
    ];
    f.context.callTool = vi.fn(async () => ({ text: "screenshot", isError: false, content }));
    await runClaudeProtocol(f.channel, f.context);
    expect(f.channel.request).toHaveBeenCalledWith(
      "rakazo/start",
      expect.objectContaining({
        media: [
          {
            kind: "image",
            label: expect.stringContaining('"source":"current"'),
            mimeType: "image/png" as const,
            data: data.toString("base64"),
          },
        ],
      }),
    );
    expect(f.send).toHaveBeenCalledWith({
      id: "tool",
      result: { text: "screenshot", isError: false, content },
    });
  });
  it("rejects audio instead of silently transcribing or dropping it", async () => {
    const f = setup([result()]);
    f.context.request.model.acceptsAudio = true;
    f.context.request.currentTurnAudio = [
      { name: "voice.wav", mimeType: "audio/wav", data: new Uint8Array(44) },
    ];
    await expect(runClaudeProtocol(f.channel, f.context)).rejects.toThrow(/unsupported/);
    expect(f.channel.request).not.toHaveBeenCalled();
  });
});

describe("Claude resumable journal barrier", () => {
  function guard(
    options: {
      path?: string;
      entry?: Record<string, unknown>;
      openedPath?: string;
      rootPath?: string;
      fileSize?: number;
      regular?: boolean;
    } = {},
  ) {
    const source = CLAUDE_SANDBOX_RUNNER.slice(
      CLAUDE_SANDBOX_RUNNER.indexOf("async function awaitJournal"),
      CLAUDE_SANDBOX_RUNNER.indexOf("async function start"),
    );
    const bytes = Buffer.from(
      `${options.fileSize ? "\n" : ""}${JSON.stringify(
        options.entry ?? {
          sessionId: "session",
          type: "assistant",
          message: { content: [{ type: "tool_use", id: "call" }] },
        },
      )}\n`,
    );
    const close = vi.fn(async () => undefined);
    const read = vi.fn(async (target: Buffer) => {
      bytes.copy(target);
      return { bytesRead: bytes.length };
    });
    const open = vi.fn(async () => ({
      fd: 7,
      stat: async () => ({
        size: options.fileSize ?? bytes.length,
        isFile: () => options.regular !== false,
      }),
      read,
      close,
    }));
    let time = 0;
    const invoke = runInNewContext(`${source}; awaitJournal`, {
      Buffer,
      constants: { O_RDONLY: 0, O_NOFOLLOW: 1, O_NONBLOCK: 2 },
      sep: "/",
      basename: (path: string) => path.split("/").at(-1),
      realpath: async (path: string) =>
        path === "/sessions/claude-projects"
          ? (options.rootPath ?? path)
          : path === "/proc/self/fd/7"
            ? (options.openedPath ?? "/sessions/claude-projects/project/session.jsonl")
            : (options.path ?? "/sessions/claude-projects/project/session.jsonl"),
      open,
      Date: {
        now: () => {
          time += 2500;
          return time;
        },
      },
      setTimeout: (callback: () => void) => callback(),
    }) as (input: Record<string, unknown>) => Promise<void>;
    return { invoke, open, close, read };
  }
  const input = {
    session_id: "session",
    tool_use_id: "call",
    transcript_path: "/home/harness/.claude/projects/project/session.jsonl",
  };
  it("requires a durable matching session/tool request before dispatch", async () => {
    const f = guard();
    await f.invoke(input);
    expect(f.open).toHaveBeenCalledWith("/sessions/claude-projects/project/session.jsonl", 3);
    expect(f.close).toHaveBeenCalledOnce();
  });
  it("reads at most a 2 MiB tail even for a large historical journal", async () => {
    const f = guard({ fileSize: 32 * 1024 * 1024 });
    await f.invoke(input);
    expect(f.read).toHaveBeenCalledWith(expect.any(Buffer), 0, 2 * 1024 * 1024, 30 * 1024 * 1024);
    expect(f.read.mock.calls[0]?.[0].length).toBe(2 * 1024 * 1024);
  });
  it.each([
    "/tmp/session.jsonl",
    "/sessions/claude-projects-evil/session.jsonl",
    "/sessions/claude-projects/project/other.jsonl",
  ])("rejects a foreign journal path %s before opening", async (path) => {
    const f = guard({ path });
    await expect(f.invoke(input)).rejects.toThrow(/scope mismatch/);
    expect(f.open).not.toHaveBeenCalled();
  });
  it("rejects swapped parent directories and a symlinked journal root", async () => {
    const swapped = guard({ openedPath: "/tmp/session.jsonl" });
    await expect(swapped.invoke(input)).rejects.toThrow(/scope mismatch/);
    expect(swapped.read).not.toHaveBeenCalled();
    expect(swapped.close).toHaveBeenCalledOnce();
    const root = guard({ rootPath: "/tmp/foreign" });
    await expect(root.invoke(input)).rejects.toThrow(/root mismatch/);
    expect(root.open).not.toHaveBeenCalled();
  });
  it("rejects FIFOs, malformed identity, and missing durable tool records", async () => {
    await expect(guard({ regular: false }).invoke(input)).rejects.toThrow(/Invalid native journal/);
    await expect(guard().invoke({ ...input, session_id: "../session" })).rejects.toThrow(
      /identity/,
    );
    const f = guard({
      entry: {
        sessionId: "different",
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "call" }] },
      },
    });
    await expect(f.invoke(input)).rejects.toThrow(/did not acknowledge/);
    expect(f.close).toHaveBeenCalled();
  });
});

describe("Claude explicit compatible-provider configuration", () => {
  it("keeps API key and bearer header modes exclusive and passes exact role models", () => {
    const { request } = setup([]).context;
    request.model.apiKey = "fake-selected-api-key";
    request.model.baseUrl = "https://example.invalid/anthropic";
    request.model.modelRoles = {
      haiku: "small-model",
      sonnet: "balanced-model",
      opus: "large-model[1m]",
      fable: "fast-model",
      subagent: "helper-model",
    };
    expect(buildClaudeProcess(request).env).toEqual({
      ANTHROPIC_API_KEY: "fake-selected-api-key",
      ANTHROPIC_BASE_URL: "https://example.invalid/anthropic",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "small-model",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "balanced-model",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "large-model[1m]",
      ANTHROPIC_DEFAULT_FABLE_MODEL: "fast-model",
      CLAUDE_CODE_SUBAGENT_MODEL: "helper-model",
    });
    request.model.authScheme = "bearer";
    expect(buildClaudeProcess(request).env?.ANTHROPIC_AUTH_TOKEN).toBe("fake-selected-api-key");
    expect(buildClaudeProcess(request).env).not.toHaveProperty("ANTHROPIC_API_KEY");
  });
  it.each([
    { role: "unrecognized", model: "model" },
    { role: "__proto__", model: "model" },
    { role: "haiku", model: "" },
    { role: "haiku", model: " model" },
    { role: "haiku", model: "model\nNODE_OPTIONS=unsafe" },
    { role: "haiku", model: "m".repeat(201) },
  ])("rejects invalid role configuration $role", ({ role, model }) => {
    const { request } = setup([]).context;
    request.model.modelRoles = { [role]: model };
    expect(() => buildClaudeProcess(request)).toThrow("Invalid Claude model role");
  });
});
