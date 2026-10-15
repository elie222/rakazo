import { createHash } from "node:crypto";
import type { AdapterContext, AgentInputAudio, ArtifactStore } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { ATTACHMENT_MAX_BYTES } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import {
  loadCurrentTurnMedia,
  validateAgentInputMedia,
  validateAudioContent,
} from "./agent-input-media.js";

function wav(): Buffer {
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
}
const context: AdapterContext = {
  spaceId: "space-1",
  userId: "user-1",
  operationId: "op-1",
  traceId: "op-1",
  signal: new AbortController().signal,
};
function fixture() {
  const bytes = wav();
  const row = {
    id: "artifact-1",
    spaceId: "space-1",
    userId: "user-1",
    name: "original.wav",
    mimeType: "audio/wav",
    size: bytes.length,
    storageKey: "stored-1",
    hash: createHash("sha256").update(bytes).digest("hex"),
  };
  const findMany = vi.fn().mockResolvedValue([row]);
  const get = vi.fn().mockResolvedValue(bytes);
  const deps = {
    prisma: { artifact: { findMany } } as unknown as PrismaClient,
    artifacts: { get } as unknown as ArtifactStore,
  };
  const blocks: MessageBlock[] = [
    {
      kind: "file",
      artifactId: row.id,
      name: "untrusted-name.wav",
      mimeType: "audio/wav",
      size: bytes.length,
    },
  ];
  return { bytes, row, findMany, get, deps, blocks };
}

describe("native input media", () => {
  it("hydrates original owned audio bytes without transcription or a network fetch", async () => {
    const { bytes, row, findMany, get, deps, blocks } = fixture();
    const result = await loadCurrentTurnMedia(deps, blocks, context);
    expect(result).toEqual({
      images: [],
      audio: [{ name: row.name, mimeType: "audio/wav", data: bytes }],
    });
    expect(result.audio[0]?.data).toBe(bytes);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: [row.id] }, spaceId: context.spaceId, userId: context.userId },
      }),
    );
    expect(get).toHaveBeenCalledWith(row.storageKey, context, { maxBytes: bytes.length });
  });

  it.each(["spaceId", "userId"] as const)(
    "rejects a foreign %s before reading storage",
    async (key) => {
      const { row, get, deps, blocks } = fixture();
      row[key] = "other";
      await expect(loadCurrentTurnMedia(deps, blocks, context)).rejects.toThrow("unavailable");
      expect(get).not.toHaveBeenCalled();
    },
  );

  it.each([
    "../secret",
    "/etc/passwd",
    "https://example.test/audio.wav",
    "folder/file",
    "..",
    "a\\b",
    "x\0y",
  ])("rejects storage path or URL %s", async (storageKey) => {
    const { row, get, deps, blocks } = fixture();
    row.storageKey = storageKey;
    await expect(loadCurrentTurnMedia(deps, blocks, context)).rejects.toThrow("storage reference");
    expect(get).not.toHaveBeenCalled();
  });

  it("fails closed on missing, wrong MIME, forged content and size metadata", async () => {
    const a = fixture();
    a.findMany.mockResolvedValue([]);
    await expect(loadCurrentTurnMedia(a.deps, a.blocks, context)).rejects.toThrow("unavailable");
    const b = fixture();
    b.row.mimeType = "audio/mpeg";
    await expect(loadCurrentTurnMedia(b.deps, b.blocks, context)).rejects.toThrow("format");
    const c = fixture();
    c.row.hash = "0".repeat(64);
    await expect(loadCurrentTurnMedia(c.deps, c.blocks, context)).rejects.toThrow("integrity");
    const d = fixture();
    d.row.size += 1;
    await expect(loadCurrentTurnMedia(d.deps, d.blocks, context)).rejects.toThrow("integrity");
    const e = fixture();
    e.row.size = ATTACHMENT_MAX_BYTES + 1;
    await expect(loadCurrentTurnMedia(e.deps, e.blocks, context)).rejects.toThrow("limit");
    expect(e.get).not.toHaveBeenCalled();
  });

  it("enforces count and aggregate size before consuming oversized payloads", async () => {
    const audio: AgentInputAudio = { name: "a.wav", mimeType: "audio/wav", data: wav() };
    await expect(validateAgentInputMedia({ audio: Array(5).fill(audio) })).rejects.toThrow("limit");
    await expect(
      validateAgentInputMedia({
        audio: [{ ...audio, data: Buffer.alloc(ATTACHMENT_MAX_BYTES + 1) }],
      }),
    ).rejects.toThrow("limit");
    const { deps, blocks, get } = fixture();
    await expect(
      loadCurrentTurnMedia(deps, [...blocks, ...blocks, ...blocks, ...blocks, ...blocks], context),
    ).rejects.toThrow("count");
    expect(get).not.toHaveBeenCalled();
  });

  it("validates decoded image content and preserves original image bytes", async () => {
    const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: "white" } })
      .png()
      .toBuffer();
    await expect(
      validateAgentInputMedia({
        images: [{ name: "picture.png", mimeType: "image/png", data: bytes }],
      }),
    ).resolves.toBeUndefined();
    await expect(
      validateAgentInputMedia({
        images: [{ name: "picture.jpg", mimeType: "image/jpeg", data: bytes }],
      }),
    ).rejects.toThrow("format");
    await expect(
      validateAgentInputMedia({
        images: [{ name: "picture.png", mimeType: "image/png", data: bytes.subarray(0, 30) }],
      }),
    ).rejects.toThrow("format");
  });

  it("rejects tiny-frame animation bombs and applies a decoder deadline", async () => {
    const pixels = Buffer.from(Array.from({ length: 257 * 3 }, (_, i) => i % 251));
    const bytes = await sharp(pixels, {
      raw: { width: 1, height: 257, channels: 3, pageHeight: 1 },
    })
      .gif({ delay: 10, keepDuplicateFrames: true, interFrameMaxError: 0 })
      .toBuffer();
    expect((await sharp(bytes).metadata()).pages).toBe(257);
    const timeout = vi.spyOn(sharp.prototype, "timeout");
    try {
      await expect(
        validateAgentInputMedia({
          images: [{ name: "many.gif", mimeType: "image/gif", data: bytes }],
        }),
      ).rejects.toThrow("format");
      expect(timeout).toHaveBeenCalledWith({ seconds: 5 });
    } finally {
      timeout.mockRestore();
    }
  });

  it("rejects truncated audio, incompatible MIME, unsupported URL-like input and malformed typed values", async () => {
    expect(() => validateAudioContent("audio/wav", wav())).not.toThrow();
    expect(() => validateAudioContent("audio/wav", wav().subarray(0, 30))).toThrow("format");
    expect(() => validateAudioContent("audio/mpeg", wav())).toThrow("format");
    expect(() => validateAudioContent("audio/unknown", wav())).toThrow("format");
    expect(() =>
      validateAudioContent("audio/wav", Buffer.from("https://example.test/audio.wav")),
    ).toThrow("format");
    await expect(validateAgentInputMedia({ audio: [{}] } as never)).rejects.toThrow("format");
    await expect(validateAgentInputMedia({ audio: "bad" } as never)).rejects.toThrow("format");
  });

  it("honors cancellation before and after storage reads", async () => {
    const a = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      loadCurrentTurnMedia(a.deps, a.blocks, { ...context, signal: controller.signal }),
    ).rejects.toThrow();
    expect(a.get).not.toHaveBeenCalled();
    const b = fixture();
    const during = new AbortController();
    b.get.mockImplementation(async () => {
      during.abort();
      return b.bytes;
    });
    await expect(
      loadCurrentTurnMedia(b.deps, b.blocks, { ...context, signal: during.signal }),
    ).rejects.toThrow();
  });
});
