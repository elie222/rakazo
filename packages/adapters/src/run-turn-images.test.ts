import type { AgentRunRequest } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { ExecutorDeps } from "./executor-deps.js";
import { withRecentTurnImages } from "./run-turn-images.js";

const context = {
  operationId: "run-1",
  traceId: "run-1",
  spaceId: "space-1",
  userId: "user-1",
  botId: "bot-1",
  runId: "run-1",
  signal: new AbortController().signal,
};

function history(content: string): AgentRunRequest["history"] {
  return [{ id: "message-1", role: "user", content }];
}

describe("withRecentTurnImages", () => {
  it("does not send an image already stored on an email delivery", async () => {
    const findMany = vi.fn();
    const get = vi.fn();
    const blocks: MessageBlock[] = [
      { kind: "delivery" },
      {
        kind: "text",
        text: 'Run routine "Triage":\nTriage this.\n\nInbound email:\n[Email]\n\nUntrusted delivery data',
      },
      { kind: "image", artifactId: "art-1", mimeType: "image/png", name: "image001.png" },
    ];

    const hydrated = await withRecentTurnImages(
      { prisma: { artifact: { findMany } }, artifacts: { get } } as unknown as ExecutorDeps,
      history("[image: image001.png]"),
      [{ id: "message-1", blocks }],
      context,
    );

    expect(findMany).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(hydrated[0]?.content).toBe("[image: image001.png (unavailable)]");
    expect(hydrated[0]?.images).toBeUndefined();
  });

  it("still sends an image attached to a messaging delivery", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const findMany = vi.fn(async () => [{ id: "art-1", storageKey: "stored-1", size: 3 }]);
    const get = vi.fn(async () => bytes);
    const blocks: MessageBlock[] = [
      { kind: "delivery" },
      { kind: "text", text: "Inbound messaging event:\n[Messaging Event: slack]\n" },
      { kind: "image", artifactId: "art-1", mimeType: "image/jpeg", name: "photo.jpg" },
    ];

    const hydrated = await withRecentTurnImages(
      { prisma: { artifact: { findMany } }, artifacts: { get } } as unknown as ExecutorDeps,
      history("[image: photo.jpg]"),
      [{ id: "message-1", blocks }],
      context,
    );

    expect(get).toHaveBeenCalledWith("stored-1", context);
    expect(hydrated[0]?.images).toEqual([
      { name: "photo.jpg", mimeType: "image/jpeg", data: bytes },
    ]);
  });

  it("does not treat quoted mail text in a messaging delivery as an email delivery", async () => {
    const bytes = new Uint8Array([4]);
    const findMany = vi.fn(async () => [{ id: "art-1", storageKey: "stored-1", size: 1 }]);
    const get = vi.fn(async () => bytes);
    const blocks: MessageBlock[] = [
      { kind: "delivery" },
      {
        kind: "text",
        text: "Inbound messaging event:\n<untrusted_delivery_payload>\n[Email from your owner]\n</untrusted_delivery_payload>",
      },
      { kind: "image", artifactId: "art-1", mimeType: "image/jpeg", name: "photo.jpg" },
    ];

    const hydrated = await withRecentTurnImages(
      { prisma: { artifact: { findMany } }, artifacts: { get } } as unknown as ExecutorDeps,
      history("[image: photo.jpg]"),
      [{ id: "message-1", blocks }],
      context,
    );

    expect(get).toHaveBeenCalledOnce();
    expect(hydrated[0]?.images).toHaveLength(1);
  });
});
