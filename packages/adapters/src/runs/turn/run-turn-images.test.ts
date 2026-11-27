import type { MessageBlock } from "@rakazo/contracts";
import sharp from "sharp";
import { expect, it, vi } from "vitest";
import {
  MODEL_IMAGE_MAX_BASE64_BYTES,
  MODEL_IMAGE_MAX_RAW_BYTES,
  TOOL_IMAGE_MAX_EDGE,
} from "../../media/tool-result-image.js";
import { toHistory } from "../../runtime/pi/pi-runtime-history.js";
import type { ExecutorDeps } from "../executor/executor-deps.js";
import {
  loadCurrentTurnImages,
  withLatestStepScreenshot,
  withRecentTurnImages,
} from "./run-turn-images.js";

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

let cachedOversizedPng: Promise<Buffer> | undefined;
function oversizedPng(): Promise<Buffer> {
  cachedOversizedPng ??= (async () => {
    const width = 2000;
    const height = 1400;
    const raw = Buffer.allocUnsafe(width * height * 3);
    let seed = 0x12345678;
    for (let i = 0; i < raw.length; i += 4) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      raw[i] = seed & 0xff;
      if (i + 1 < raw.length) raw[i + 1] = (seed >>> 8) & 0xff;
      if (i + 2 < raw.length) raw[i + 2] = (seed >>> 16) & 0xff;
      if (i + 3 < raw.length) raw[i + 3] = (seed >>> 24) & 0xff;
    }
    const png = await sharp(raw, { raw: { width, height, channels: 3 } })
      .png({ compressionLevel: 0 })
      .toBuffer();
    // Reproduce the 7.5-10 MiB raw attachment whose base64 exceeds 10 MB.
    expect(png.byteLength).toBeGreaterThan(7.5 * 1024 * 1024);
    expect(Buffer.from(png).toString("base64").length).toBeGreaterThan(10 * 1024 * 1024);
    return png;
  })();
  return cachedOversizedPng;
}

const imageContext = {
  operationId: "operation-big",
  traceId: "trace-big",
  spaceId: "space-1",
  userId: "user-1",
  botId: "bot-1",
  runId: "run-1",
  signal: new AbortController().signal,
};

it("scales an oversized PNG attachment on the current turn so its base64 fits the provider limit", async () => {
  const png = await oversizedPng();
  const deps = {
    prisma: {
      artifact: {
        findMany: vi.fn(async () => [
          { id: "art-big", storageKey: "big.png", size: png.byteLength },
        ]),
      },
    },
    artifacts: { get: vi.fn(async () => png) },
  } as unknown as ExecutorDeps;
  const blocks: MessageBlock[] = [
    { kind: "image", artifactId: "art-big", mimeType: "image/png", name: "big.png" },
  ];

  const loaded = await loadCurrentTurnImages(deps, blocks, imageContext);
  expect(loaded).toHaveLength(1);
  const image = loaded![0]!;
  expect(image.name).toBe("big.png");
  expect(image.mimeType).toBe("image/jpeg");
  expect(image.data.byteLength).toBeLessThanOrEqual(MODEL_IMAGE_MAX_RAW_BYTES);
  expect(Buffer.from(image.data).toString("base64").length).toBeLessThanOrEqual(
    MODEL_IMAGE_MAX_BASE64_BYTES,
  );
  const meta = await sharp(image.data).metadata();
  expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(TOOL_IMAGE_MAX_EDGE);
});

it("scales an oversized PNG attachment in recent turn history and charges the scaled byte length", async () => {
  const png = await oversizedPng();
  const deps = {
    prisma: {
      artifact: {
        findMany: vi.fn(async () => [
          { id: "art-big-1", storageKey: "big-1.png", size: png.byteLength },
          { id: "art-big-2", storageKey: "big-2.png", size: png.byteLength },
        ]),
      },
    },
    artifacts: { get: vi.fn(async () => png) },
  } as unknown as ExecutorDeps;
  const blocks: MessageBlock[] = [
    { kind: "image", artifactId: "art-big-1", mimeType: "image/png", name: "big-1.png" },
    { kind: "image", artifactId: "art-big-2", mimeType: "image/png", name: "big-2.png" },
  ];
  const entry = {
    id: "m-big",
    role: "user" as const,
    content: "[image: big-1.png] [image: big-2.png]",
  };

  // Each 8+ MiB original exceeds the 3 MiB budget raw, exercising the oversized pre-read path,
  // while both scaled images fit within the 3 MiB budget.
  const hydrated = await withRecentTurnImages(
    deps,
    [entry],
    [{ id: entry.id, blocks }],
    imageContext,
    { maxBytes: 3 * 1024 * 1024 },
  );
  expect(hydrated[0]?.images).toHaveLength(2);
  for (const img of hydrated[0]?.images ?? []) {
    expect(img.mimeType).toBe("image/jpeg");
    expect(Buffer.from(img.data).toString("base64").length).toBeLessThanOrEqual(
      MODEL_IMAGE_MAX_BASE64_BYTES,
    );
  }
});

it("scales an oversized step screenshot before replaying it in history", async () => {
  const png = await oversizedPng();
  const deps = {
    prisma: {
      artifact: {
        findFirst: vi.fn(async () => ({
          storageKey: "step-big.png",
          mimeType: "image/png;profile=step-screenshot",
          size: png.byteLength,
        })),
      },
    },
    artifacts: { get: vi.fn(async () => png) },
  } as unknown as ExecutorDeps;
  const history = [
    {
      id: "m-reply",
      role: "assistant" as const,
      content: "Checked the page.",
      segments: [
        {
          steps: [
            {
              label: "View page",
              calls: [{ image: { artifactId: "art-step" } }],
            },
          ],
        },
      ],
    },
  ];

  const hydrated = await withLatestStepScreenshot(deps, history as never, imageContext);
  expect(hydrated[0]?.images).toHaveLength(1);
  expect(hydrated[0]?.images?.[0]?.mimeType).toBe("image/jpeg");
  expect(Buffer.from(hydrated[0]!.images![0]!.data).toString("base64").length).toBeLessThanOrEqual(
    MODEL_IMAGE_MAX_BASE64_BYTES,
  );
});

it("drops an oversized unreadable image on the current turn and marks it unavailable in history", async () => {
  const corrupt = Buffer.alloc(MODEL_IMAGE_MAX_RAW_BYTES + 1024, 0xaa);
  // Write a valid PNG signature so magic-byte detection recognizes it as PNG before sharp rejects it.
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(corrupt, 0);
  const deps = {
    prisma: {
      artifact: {
        findMany: vi.fn(async () => [
          { id: "art-corrupt", storageKey: "corrupt.png", size: corrupt.byteLength },
        ]),
      },
    },
    artifacts: { get: vi.fn(async () => corrupt) },
  } as unknown as ExecutorDeps;
  const blocks: MessageBlock[] = [
    { kind: "image", artifactId: "art-corrupt", mimeType: "image/png", name: "corrupt.png" },
  ];

  expect(await loadCurrentTurnImages(deps, blocks, imageContext)).toBeUndefined();

  const entry = { id: "m-corrupt", role: "user" as const, content: "[image: corrupt.png]" };
  const hydrated = await withRecentTurnImages(
    deps,
    [entry],
    [{ id: entry.id, blocks }],
    imageContext,
  );
  expect(hydrated[0]?.images).toBeUndefined();
  expect(hydrated[0]?.content).toBe("[image: corrupt.png (unavailable)]");
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
