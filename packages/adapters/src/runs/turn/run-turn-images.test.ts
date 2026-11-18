import type { MessageBlock } from "@rakazo/contracts";
import { expect, it, vi } from "vitest";
import { toHistory } from "../../runtime/pi/pi-runtime-history.js";
import type { ExecutorDeps } from "../executor/executor-deps.js";
import { loadCurrentTurnImages, withRecentTurnImages } from "./run-turn-images.js";

it("sends a PNG labeled as JPEG with its actual type on the current turn and in history", async () => {
  const data = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const deps = {
    prisma: {
      artifact: {
        findMany: vi.fn(async () => [
          { id: "art-1", storageKey: "stored-1", size: data.byteLength },
        ]),
      },
    },
    artifacts: { get: vi.fn(async () => data) },
  } as unknown as ExecutorDeps;
  const blocks: MessageBlock[] = [
    { kind: "image", artifactId: "art-1", mimeType: "image/jpeg", name: "photo.jpg" },
  ];
  const context = {
    operationId: "operation-1",
    traceId: "trace-1",
    spaceId: "space-1",
    userId: "user-1",
    botId: "bot-1",
    runId: "run-1",
    signal: new AbortController().signal,
  };
  const images = [{ name: "photo.jpg", mimeType: "image/png", data }];
  expect(await loadCurrentTurnImages(deps, blocks, context)).toEqual(images);

  const message = { id: "message-1", role: "user" as const, content: "[image: photo.jpg]" };
  expect(
    await withRecentTurnImages(deps, [message], [{ id: message.id, blocks }], context),
  ).toEqual([{ ...message, images }]);
});

it("marks re-hydrated history images as already seen when they are replayed", async () => {
  const data = new Uint8Array([1, 2]);
  const deps = {
    prisma: {
      artifact: {
        findMany: vi.fn(async () => [
          { id: "art-1", storageKey: "stored-1", size: data.byteLength },
        ]),
      },
    },
    artifacts: { get: vi.fn(async () => data) },
  } as unknown as ExecutorDeps;
  const blocks: MessageBlock[] = [
    { kind: "image", artifactId: "art-1", mimeType: "image/png", name: "shot.png" },
  ];
  const context = {
    operationId: "operation-1",
    traceId: "trace-1",
    spaceId: "space-1",
    userId: "user-1",
    botId: "bot-1",
    runId: "run-1",
    signal: new AbortController().signal,
  };
  const imageOnly = {
    id: "message-1",
    role: "user" as const,
    content: "",
    createdAt: "2026-11-19T02:31:00.000Z",
  };
  const captioned = {
    id: "message-2",
    role: "user" as const,
    content: "look at this",
    createdAt: "2026-11-19T02:10:00.000Z",
  };
  const hydrated = await withRecentTurnImages(
    deps,
    [captioned, imageOnly],
    [
      { id: captioned.id, blocks },
      { id: imageOnly.id, blocks },
    ],
    context,
  );
  expect(hydrated.map((entry) => entry.images?.length ?? 0)).toEqual([1, 1]);

  const replayed = toHistory(hydrated, "what time is that flight?");
  expect(replayed.map((message) => message.content)).toEqual([
    [
      {
        type: "text",
        text: "[2026-11-19 02:10, image from an earlier message; already seen]\nlook at this",
      },
      { type: "image", data: Buffer.from(data).toString("base64"), mimeType: "image/png" },
    ],
    [
      { type: "text", text: "[2026-11-19 02:31, image from an earlier message; already seen]" },
      { type: "image", data: Buffer.from(data).toString("base64"), mimeType: "image/png" },
    ],
  ]);
});
