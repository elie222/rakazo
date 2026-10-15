import type {
  AgentInputAudio,
  AgentInputImage,
  AgentRunRequest,
  AgentToolResultContent,
} from "@rakazo/adapter-kit";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  prepareNativeMedia,
  validateNativeToolContent,
  withNativeHistoryMedia,
} from "./primary-harness-media.js";

function request(): AgentRunRequest {
  return {
    runId: "run",
    botId: "bot",
    threadId: "thread",
    sourceMessageId: "current-message",
    prompt: "Inspect attached media",
    instructions: "Preserve source attribution",
    history: [],
    tools: [],
    model: {
      provider: "custom",
      id: "media-model",
      baseUrl: "https://custom.example/v1",
      acceptsImages: true,
      acceptsAudio: true,
    },
    executeTool: async () => "ok",
  };
}
async function picture(): Promise<AgentInputImage> {
  return {
    name: "../../private.png",
    mimeType: "image/png",
    data: await sharp({ create: { width: 1, height: 1, channels: 3, background: "red" } })
      .png()
      .toBuffer(),
  };
}
function recording(): AgentInputAudio {
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
  return { name: "original.wav", mimeType: "audio/wav", data };
}
describe("native multimodal boundary", () => {
  it.each(["claude", "codex", "kimi"] as const)(
    "preserves original image bytes and provenance for %s",
    async (harness) => {
      const r = request();
      const img = await picture();
      r.currentTurnImages = [img];
      r.history = [{ id: "other-bot", role: "assistant", content: "Shared result", images: [img] }];
      const parts = await prepareNativeMedia(r, harness);
      expect(parts).toHaveLength(2);
      expect(Buffer.from(parts[1]!.data, "base64")).toEqual(img.data);
      expect(JSON.parse(parts[0]!.label)).toMatchObject({
        source: "history",
        messageId: "other-bot",
        role: "assistant",
      });
      expect(JSON.parse(parts[1]!.label)).toMatchObject({
        source: "current",
        messageId: "current-message",
        name: "../../private.png",
      });
    },
  );
  it("sends original audio only through a declared custom Codex Responses model", async () => {
    const r = request();
    const audio = recording();
    r.currentTurnAudio = [audio];
    const [part] = await prepareNativeMedia(r, "codex");
    expect(part?.kind).toBe("audio");
    expect(part?.mimeType).toBe("audio/wav");
    expect(Buffer.from(part!.data, "base64")).toEqual(audio.data);
  });
  it.each(["claude", "kimi"] as const)(
    "fails unsupported %s audio without substituting transcription",
    async (harness) => {
      const r = request();
      r.currentTurnAudio = [recording()];
      await expect(prepareNativeMedia(r, harness)).rejects.toThrow(
        "transcription is not substituted",
      );
    },
  );
  it.each([
    "https://api.openai.com/v1",
    "https://chatgpt.com/backend-api/codex",
    "https://tenant.openai.com/v1",
  ])("rejects official endpoint audio despite declaration: %s", async (baseUrl) => {
    const r = request();
    r.model.baseUrl = baseUrl;
    r.currentTurnAudio = [recording()];
    await expect(prepareNativeMedia(r, "codex")).rejects.toThrow("unsupported");
  });
  it("requires explicit model image and audio declarations", async () => {
    const r = request();
    r.currentTurnImages = [await picture()];
    r.model.acceptsImages = undefined;
    await expect(prepareNativeMedia(r, "codex")).rejects.toThrow("not enabled");
    r.currentTurnImages = [];
    r.currentTurnAudio = [recording()];
    r.model.acceptsAudio = false;
    await expect(prepareNativeMedia(r, "codex")).rejects.toThrow("not enabled");
  });
  it("checks aggregate history/current limits and image content before encoding", async () => {
    const r = request();
    const img = await picture();
    r.currentTurnImages = [img, img, img];
    r.history = [{ role: "user", content: "old", images: [img, img] }];
    await expect(prepareNativeMedia(r, "codex")).rejects.toThrow();
    r.history = [];
    r.currentTurnImages = [{ ...img, data: Buffer.from("not a picture") }];
    await expect(prepareNativeMedia(r, "codex")).rejects.toThrow();
  });
  it("validates tool images using the same byte and capability boundary", async () => {
    const r = request();
    const img = await picture();
    const content: AgentToolResultContent[] = [
      { type: "text", text: "Result" },
      { type: "image", mimeType: "image/png", data: Buffer.from(img.data).toString("base64") },
    ];
    await expect(validateNativeToolContent(content, r, "claude")).resolves.toBeUndefined();
    r.model.acceptsImages = false;
    await expect(validateNativeToolContent(content, r, "claude")).rejects.toThrow("not enabled");
  });
  it.each(["!!!!", "AA=A", "AB==", " YQ==", "YQ==\n"])(
    "rejects malformed/noncanonical tool encoding %j",
    async (data) => {
      await expect(
        validateNativeToolContent(
          [{ type: "image", mimeType: "image/png", data }],
          request(),
          "codex",
        ),
      ).rejects.toThrow();
    },
  );
  it("handles multi-MiB invalid tool images without recursive-regex overflow", async () => {
    const result = validateNativeToolContent(
      [{ type: "image", mimeType: "image/png", data: "A".repeat(6 * 1024 * 1024) }],
      request(),
      "codex",
    );
    await expect(result).rejects.toThrow();
    await expect(result).rejects.not.toThrow("Maximum call stack");
  });
  it("marks unavailable historical media without leaking cross-account artifact data", async () => {
    const history = [{ id: "old", role: "user" as const, content: "old media" }];
    const result = await withNativeHistoryMedia(
      { prisma: { artifact: { findMany: async () => [] } } as never },
      history,
      [
        {
          id: "old",
          blocks: [{ kind: "image", artifactId: "foreign", name: "x.png", mimeType: "image/png" }],
        },
      ],
      {
        userId: "owner",
        spaceId: "space",
        operationId: "run",
        traceId: "run",
        signal: new AbortController().signal,
      },
      { acceptsImages: true, acceptsAudio: false },
    );
    expect(result[0]?.images).toBeUndefined();
    expect(result[0]?.content).toContain("authorized scope");
    expect(history[0]?.content).toBe("old media");
  });
});
