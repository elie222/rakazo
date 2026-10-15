import type { AgentRunRequest } from "@rakazo/adapter-kit";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { runCodexProtocol } from "./primary-harness-codex.js";
import type { NativeProtocolContext } from "./primary-harness-protocol.js";

function setup() {
  const request: AgentRunRequest = {
    runId: "run",
    botId: "bot",
    threadId: "thread",
    prompt: "Inspect.",
    instructions: "Use the bridge.",
    history: [],
    tools: [],
    model: {
      provider: "custom",
      id: "configured",
      baseUrl: "https://api.example.com/v1",
      acceptsImages: true,
    },
  };
  const context: NativeProtocolContext = {
    request,
    tools: [],
    prompt: request.prompt,
    signal: new AbortController().signal,
    emit: vi.fn(),
    onSession: vi.fn(),
    setInterrupt: vi.fn(),
    callTool: vi.fn(async () => ({ text: "result", isError: false })),
  };
  const channel = {
    request: vi.fn(async (method: string, _params: Record<string, unknown>) => {
      if (method === "rakazo/start") return { version: "0.162.1" };
      if (method === "thread/start") return { thread: { id: "native" } };
      if (method === "turn/start") return { turn: { id: "turn" } };
      return {};
    }),
    send: vi.fn(async () => undefined),
    messages: {
      async *[Symbol.asyncIterator]() {
        yield {
          id: "tool",
          method: "item/tool/call",
          params: {
            threadId: "native",
            turnId: "turn",
            namespace: "rakazo",
            tool: "read_file",
            arguments: {},
            callId: "call",
          },
        };
        yield { method: "turn/completed", params: { turn: { id: "turn", status: "completed" } } };
      },
    },
  };
  return { request, context, channel };
}

describe("Codex inline media bridge", () => {
  it("preserves attributed current/history images and translates authorized tool images to data URLs", async () => {
    const f = setup();
    const data = await sharp({ create: { width: 2, height: 2, channels: 3, background: "white" } })
      .png()
      .toBuffer();
    const media = { name: "../../image.png", mimeType: "image/png" as const, data };
    f.request.currentTurnImages = [media];
    f.request.history = [{ id: "earlier", role: "user", content: "previous", images: [media] }];
    f.context.callTool = vi.fn(async () => ({
      text: "screenshot",
      isError: false,
      content: [
        { type: "text" as const, text: "screenshot" },
        { type: "image" as const, mimeType: "image/png" as const, data: data.toString("base64") },
      ],
    }));
    await runCodexProtocol(f.channel, f.context);
    const params = f.channel.request.mock.calls.find(
      ([method]) => method === "turn/start",
    )?.[1] as unknown as { input: Array<Record<string, unknown>> };
    expect(params.input.filter((item) => item.type === "image")).toEqual([
      { type: "image", url: `data:image/png;base64,${data.toString("base64")}` },
      { type: "image", url: `data:image/png;base64,${data.toString("base64")}` },
    ]);
    expect(JSON.stringify(params)).toContain('\\"messageId\\":\\"earlier\\"');
    expect(f.channel.send).toHaveBeenCalledWith({
      id: "tool",
      result: {
        success: true,
        contentItems: [
          { type: "inputText", text: "screenshot" },
          { type: "inputImage", imageUrl: `data:image/png;base64,${data.toString("base64")}` },
        ],
      },
    });
  });
  it("rejects undeclared or official-endpoint audio before starting the native process", async () => {
    const f = setup();
    f.request.currentTurnAudio = [
      { name: "voice.wav", mimeType: "audio/wav", data: new Uint8Array(44) },
    ];
    await expect(runCodexProtocol(f.channel, f.context)).rejects.toThrow(/not enabled/);
    f.request.model.acceptsAudio = true;
    f.request.model.baseUrl = "https://api.openai.com/v1";
    await expect(runCodexProtocol(f.channel, f.context)).rejects.toThrow(/unsupported/);
    expect(f.channel.request).not.toHaveBeenCalled();
  });
});
