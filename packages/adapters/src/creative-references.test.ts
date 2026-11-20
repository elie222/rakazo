import type { ConnectorCall } from "@rakazo/adapter-kit";
import { expect, it, vi } from "vitest";
import { capabilities, creativeFixture } from "./creative.test-support.js";
import type { CreativeCapabilities } from "./creative-contracts.js";
import { creativeReferenceSchema, creativeToolInputSchema } from "./creative-contracts.js";
import { ConnectorRegistry } from "./integrations/connector-registry.js";

const image = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jM1sAAAAASUVORK5CYII=",
  "base64",
);
function directory(maxBytes = 100_000): CreativeCapabilities {
  return {
    ...capabilities,
    models: capabilities.models.map((model) => ({
      ...model,
      inputs: { referenceImages: model.kind === "image" },
      constraints:
        model.kind === "image" ? { ...model.constraints, maxReferences: 2 } : model.constraints,
    })),
    submission: {
      presetOnly: false,
      referenceMedia: true,
      referenceKinds: ["image"],
      maxReferenceImageBytes: maxBytes,
    },
  };
}
async function fixture() {
  const f = creativeFixture();
  f.setCatalog(directory());
  f.artifacts.push({
    id: "source-a",
    userId: "user-a",
    spaceId: "space-a",
    botId: "bot-a",
    groupId: null,
    storageKey: "blob-a",
    size: image.byteLength,
    hash: String(image.byteLength),
    mimeType: "image/png",
    name: "source.png",
  });
  f.blobs.get = vi.fn(async () => new Uint8Array(image));
  await f.connect();
  const input = {
    kind: "image",
    model: "demo-image",
    preset: "demo-image-default",
    prompt: "Put the selected person at the entrance",
    referenceArtifactIds: ["source-a"],
  };
  const context = f.context();
  const registry = new ConnectorRegistry([f.connector]);
  const tool = (await registry.discoverTools(context)).find(
    (tool) => tool.route?.toolName === "creative_submit",
  )!;
  const execute = async (args: Record<string, unknown> = input) => {
    const events = [];
    const call: ConnectorCall = {
      tool: tool.name,
      route: tool.route,
      executionId: "reference-execution",
      args,
    };
    for await (const event of registry.execute(call, context)) events.push(event);
    return events;
  };
  return { ...f, input, execute };
}

it("uploads original owned image bytes and persists the ordered remote reference before the billed PUT", async () => {
  const f = await fixture();
  try {
    const second = Buffer.concat([image, Buffer.from([0])]);
    f.artifacts.push({
      ...f.artifacts[0]!,
      id: "source-b",
      storageKey: "blob-b",
      size: second.byteLength,
      hash: String(second.byteLength),
    });
    f.blobs.get = vi.fn(async (key) => new Uint8Array(key === "blob-b" ? second : image));
    const input = { ...f.input, referenceArtifactIds: ["source-b", "source-a"] };
    expect(await f.execute(input)).toMatchObject([{ type: "result", data: { status: "queued" } }]);
    expect(f.referenceUploads).toHaveLength(2);
    expect(f.referenceUploads.map((item) => Buffer.from(item.bytes))).toEqual([second, image]);
    const sent = f.history.find((request) => request.method === "PUT")!.input!;
    expect(sent).not.toHaveProperty("referenceArtifactIds");
    expect(sent.references).toEqual([...f.references.keys()]);
    const effect = f.effects[0]!;
    expect(effect.kind).toBe("creative_media_reference_job");
    expect(effect.result).toMatchObject({ dispatched: true, submission: sent });
    const serialized = JSON.stringify(effect);
    expect(serialized).not.toContain(image.toString("base64"));
    expect(serialized).not.toContain("fake-access-a");
    expect(f.putCount()).toBe(1);
  } finally {
    await f.connector.creativeJobs.stop();
  }
});

const video = Buffer.from([0, 0, 0, 12, 102, 116, 121, 112, 0, 0, 0, 0]);
const audio = Buffer.from("RIFFsynthetic WAVE");
function mediaDirectory(constraints: Record<string, unknown> = {}): CreativeCapabilities {
  const base = directory();
  return {
    ...base,
    models: base.models.map((model) => ({
      ...model,
      inputs: {
        referenceImages: model.kind !== "music",
        referenceVideos: model.kind === "video",
        referenceAudios: model.kind === "video",
      },
      constraints:
        model.kind === "video"
          ? ({
              ...model.constraints,
              maxImages: 2,
              maxVideos: 2,
              maxAudios: 2,
              referenceSeconds: 1,
              audioOnly: true,
              ...constraints,
            } as CreativeCapabilities["models"][number]["constraints"])
          : model.constraints,
    })),
    submission: {
      presetOnly: false,
      referenceMedia: true,
      referenceKinds: ["image", "video", "audio"],
      maxReferenceImageBytes: 100_000,
      maxReferenceMediaBytes: 200_000,
    },
  };
}
async function mediaFixture() {
  const f = await fixture();
  f.setCatalog(mediaDirectory());
  for (const [id, bytes, mimeType] of [
    ["video-a", video, "video/mp4"],
    ["audio-a", audio, "audio/wav"],
  ] as const)
    f.artifacts.push({
      ...f.artifacts[0]!,
      id,
      storageKey: id,
      size: bytes.byteLength,
      hash: String(bytes.byteLength),
      mimeType,
    });
  f.blobs.get = vi.fn(
    async (key) => new Uint8Array(key === "video-a" ? video : key === "audio-a" ? audio : image),
  );
  const input = {
    ...f.input,
    kind: "video",
    model: "demo-video",
    preset: "demo-video-default",
    parameters: { mode: "reference" },
    referenceArtifactIds: ["audio-a", "source-a", "video-a"],
  };
  return { ...f, input };
}

it("submits one image for video with an omitted preset and freezes the directory default", async () => {
  const f = await mediaFixture();
  const catalog = mediaDirectory();
  const model = catalog.models.find((model) => model.kind === "video")!;
  model.parameters = {
    type: "object",
    properties: {
      resolution: { type: "string", enum: ["768P", "1080P"] },
      ratio: { type: "string", enum: ["16:9"] },
      seconds: { type: "integer", minimum: 4, maximum: 30 },
    },
    additionalProperties: false,
  };
  model.presets = [
    { id: model.defaultPreset, parameters: { resolution: "768P", ratio: "16:9", seconds: 4 } },
  ];
  f.setCatalog(catalog);
  const { preset: _preset, parameters: _parameters, ...input } = f.input;
  try {
    expect(await f.execute({ ...input, referenceArtifactIds: ["source-a"] })).toMatchObject([
      { type: "result", data: { status: "queued" } },
    ]);
    expect(f.referenceUploads).toHaveLength(1);
    const request = f.history.find((item) => item.method === "PUT")!.input!;
    expect(request).toMatchObject({
      kind: "video",
      model: model.id,
      preset: model.defaultPreset,
      references: [...f.references.keys()],
    });
    expect(request).not.toHaveProperty("parameters");
    const saved = f.effects[0]!.request as { toolInput: object };
    expect(saved.toolInput).not.toHaveProperty("preset");
    expect(f.putCount()).toBe(1);
  } finally {
    await f.connector.creativeJobs.stop();
  }
});

it("uploads mixed references unchanged and checks audio/video duration totals independently", async () => {
  const f = await mediaFixture();
  try {
    expect(await f.execute(f.input)).toMatchObject([
      { type: "result", data: { status: "queued" } },
    ]);
    expect(f.referenceUploads.map((item) => Buffer.from(item.bytes))).toEqual([
      audio,
      image,
      video,
    ]);
    expect(f.history.find((item) => item.method === "PUT")!.input).toMatchObject({
      references: [...f.references.keys()],
      parameters: { mode: "reference" },
    });
    expect([...f.references.values()].map((item) => item.kind)).toEqual([
      "audio",
      "image",
      "video",
    ]);
    const state = f.effects[0]!.result as {
      referenceTransfers: Record<string, { kind: string; durationMs?: number }>;
    };
    expect(
      Object.values(state.referenceTransfers)
        .filter((item) => item.kind !== "image")
        .map((item) => item.durationMs),
    ).toEqual([1_000, 1_000]);
    expect(f.putCount()).toBe(1);
  } finally {
    await f.connector.creativeJobs.stop();
  }
});

it.each(["video", "audio"] as const)(
  "rejects the separately accumulated %s duration when it exceeds the directory limit",
  async (kind) => {
    const f = await mediaFixture();
    try {
      const id = kind === "video" ? "video-a" : "audio-a";
      expect(await f.execute({ ...f.input, referenceArtifactIds: [id, id] })).toMatchObject([
        { type: "error", message: "Creative app: invalid_parameters" },
      ]);
      expect(f.putCount()).toBe(0);
      expect(f.referenceUploads).toHaveLength(1);
    } finally {
      await f.connector.creativeJobs.stop();
    }
  },
);

it.each([undefined, 0] as const)(
  "does not interpret unknown/zero duration as a valid bounded reference (%s)",
  async (durationMs) => {
    const f = await mediaFixture();
    const upload = vi.spyOn(f.provider, "uploadReference").mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000002",
      kind: "audio",
      mimeType: "audio/wav",
      bytes: audio.byteLength,
      durationMs,
    });
    try {
      expect(await f.execute({ ...f.input, referenceArtifactIds: ["audio-a"] })).toMatchObject([
        { type: "error", message: "Creative app: invalid_reference_media" },
      ]);
      expect(f.putCount()).toBe(0);
    } finally {
      upload.mockRestore();
      await f.connector.creativeJobs.stop();
    }
  },
);

it("uses the uploaded kind for audio-only MP4 and rejects unsupported actual media", async () => {
  const f = await mediaFixture();
  f.artifacts.find((row) => row.id === "audio-a")!.mimeType = "video/mp4";
  const dir = mediaDirectory();
  dir.models.find((model) => model.kind === "video")!.inputs!.referenceVideos = false;
  f.setCatalog(dir);
  try {
    expect(await f.execute({ ...f.input, referenceArtifactIds: ["audio-a"] })).toMatchObject([
      { type: "result", data: { status: "queued" } },
    ]);
    expect([...f.references.values()][0]!.kind).toBe("audio");
  } finally {
    await f.connector.creativeJobs.stop();
  }
  const refused = await mediaFixture();
  refused.setCatalog(dir);
  try {
    expect(
      await refused.execute({ ...refused.input, referenceArtifactIds: ["video-a"] }),
    ).toMatchObject([{ type: "error", message: "Creative app: invalid_parameters" }]);
    expect(refused.putCount()).toBe(0);
  } finally {
    await refused.connector.creativeJobs.stop();
  }
});

it("enforces mixed-mode, audio-only and image-required rules before a billed request", async () => {
  const f = await mediaFixture();
  try {
    expect(await f.execute({ ...f.input, parameters: { mode: "frames" } })).toMatchObject([
      { type: "error", message: "Creative app: invalid_parameters" },
    ]);
    expect(f.putCount()).toBe(0);
  } finally {
    await f.connector.creativeJobs.stop();
  }
  for (const constraints of [{ audioOnly: false }, { requireImage: true }]) {
    const next = await mediaFixture();
    next.setCatalog(mediaDirectory(constraints));
    try {
      expect(
        await next.execute({ ...next.input, referenceArtifactIds: ["audio-a"] }),
      ).toMatchObject([{ type: "error", message: "Creative app: invalid_parameters" }]);
      expect(next.putCount()).toBe(0);
    } finally {
      await next.connector.creativeJobs.stop();
    }
  }
});

it("retains first/last frame image order in explicit frames mode", async () => {
  const f = await mediaFixture();
  try {
    expect(
      await f.execute({
        ...f.input,
        parameters: { mode: "frames" },
        referenceArtifactIds: ["source-a", "source-a"],
      }),
    ).toMatchObject([{ type: "result", data: { status: "queued" } }]);
    const id = [...f.references.keys()][0]!;
    expect(f.history.find((item) => item.method === "PUT")!.input).toMatchObject({
      references: [id, id],
      parameters: { mode: "frames" },
    });
  } finally {
    await f.connector.creativeJobs.stop();
  }
});

it("checks each media byte limit and known type count without enabling music references", async () => {
  const f = await mediaFixture();
  try {
    const limited = mediaDirectory();
    limited.submission!.maxReferenceMediaBytes = audio.byteLength - 1;
    f.setCatalog(limited);
    expect(await f.execute({ ...f.input, referenceArtifactIds: ["audio-a"] })).toMatchObject([
      { type: "error", message: "Creative app: reference_media_too_large" },
    ]);
    f.setCatalog(mediaDirectory({ maxAudios: 0 }));
    expect(await f.execute({ ...f.input, referenceArtifactIds: ["audio-a"] })).toMatchObject([
      { type: "error", message: "Creative app: invalid_parameters" },
    ]);
    f.setCatalog(mediaDirectory());
    expect(
      await f.execute({ ...f.input, kind: "music", model: "demo-music", preset: "demo-inst" }),
    ).toMatchObject([{ type: "error", message: "Creative app: invalid_parameters" }]);
    expect(f.putCount()).toBe(0);
    expect(f.referenceUploads).toHaveLength(0);
  } finally {
    await f.connector.creativeJobs.stop();
  }
});

it("resumes uncertain media uploads and paid responses with the original mixed reference IDs", async () => {
  const f = await mediaFixture();
  try {
    f.loseReferenceResponse();
    await f.execute(f.input);
    expect(f.putCount()).toBe(0);
    f.losePut();
    const restored = f.rebuild();
    const id = String(f.effects[0]!.id);
    await restored.creativeJobs.poll(id);
    const uploads = f.referenceUploads.length;
    const request = f.history.find((item) => item.method === "PUT")!.input;
    f.setCatalog({ models: [], defaults: {} });
    await restored.creativeJobs.poll(id);
    expect(f.putCount()).toBe(1);
    expect(f.referenceUploads).toHaveLength(uploads);
    expect(f.effects[0]!.result).toMatchObject({ submission: request, accepted: true });
    await restored.creativeJobs.stop();
  } finally {
    await f.connector.creativeJobs.stop();
  }
});

it("preserves optional media metadata and rejects a kind/MIME mismatch", () => {
  const base = {
    id: "00000000-0000-4000-8000-000000000003",
    kind: "audio",
    mimeType: "audio/mp4",
    bytes: 128,
  };
  expect(creativeReferenceSchema.parse(base)).not.toHaveProperty("durationMs");
  expect(creativeReferenceSchema.parse({ ...base, durationMs: 0 })).toMatchObject({
    durationMs: 0,
  });
  expect(creativeReferenceSchema.safeParse({ ...base, kind: "video" }).success).toBe(false);
});

it("rejects the entire mixed selection before upload when one later attachment belongs to another user", async () => {
  const f = await mediaFixture();
  f.artifacts.find((row) => row.id === "video-a")!.userId = "user-b";
  try {
    expect(await f.execute(f.input)).toMatchObject([
      { type: "error", message: "Creative app: not_found" },
    ]);
    expect(f.referenceUploads).toHaveLength(0);
    expect(f.putCount()).toBe(0);
  } finally {
    await f.connector.creativeJobs.stop();
  }
});

it("restores image-only operations persisted by the previous release", async () => {
  const f = await fixture();
  try {
    f.loseReferenceResponse();
    await f.execute();
    const effect = f.effects[0]!;
    effect.kind = "creative_reference_job";
    const request = effect.request as {
      referencePlan: Record<string, unknown> & { artifacts: Record<string, unknown>[] };
    };
    for (const key of [
      "allowedKinds",
      "maxCounts",
      "referenceSeconds",
      "mode",
      "requireImage",
      "audioOnly",
    ])
      delete request.referencePlan[key];
    for (const source of request.referencePlan.artifacts) delete source.maxBytes;
    const restored = f.rebuild();
    await restored.creativeJobs.poll(String(effect.id));
    expect(f.putCount()).toBe(1);
    expect(f.effects[0]!.result).toMatchObject({
      accepted: true,
      submission: { references: [...f.references.keys()] },
    });
    await restored.creativeJobs.stop();
  } finally {
    await f.connector.creativeJobs.stop();
  }
});

it("recovers an uncertain non-billed upload through content deduplication and submits once", async () => {
  const f = await fixture();
  try {
    f.loseReferenceResponse();
    await f.execute();
    expect(f.putCount()).toBe(0);
    expect(f.references.size).toBe(1);
    const effect = f.effects[0]!;
    const restored = f.rebuild();
    await restored.creativeJobs.poll(String(effect.id));
    expect(f.referenceUploads).toHaveLength(2);
    expect(f.references.size).toBe(1);
    expect(f.putCount()).toBe(1);
    const reads = vi.mocked(f.blobs.get).mock.calls.length;
    await restored.creativeJobs.poll(String(effect.id));
    expect(f.referenceUploads).toHaveLength(2);
    expect(f.putCount()).toBe(1);
    expect(vi.mocked(f.blobs.get).mock.calls.length).toBe(reads);
    await restored.creativeJobs.stop();
  } finally {
    await f.connector.creativeJobs.stop();
  }
});

it("uses the saved IDs after a lost paid response and refuses a changed reference order", async () => {
  const f = await fixture();
  try {
    f.artifacts.push({ ...f.artifacts[0]!, id: "source-b", storageKey: "blob-b" });
    f.losePut();
    await f.execute({ ...f.input, referenceArtifactIds: ["source-a", "source-b"] });
    const effect = f.effects[0]!;
    const uploads = f.referenceUploads.length;
    f.setCatalog({ models: [], defaults: {} });
    const restored = f.rebuild();
    await restored.creativeJobs.poll(String(effect.id));
    expect(f.referenceUploads).toHaveLength(uploads);
    expect(f.putCount()).toBe(1);
    expect(
      await f.execute({ ...f.input, referenceArtifactIds: ["source-b", "source-a"] }),
    ).toMatchObject([{ type: "error", message: "Creative app: operation_conflict" }]);
    await restored.creativeJobs.stop();
  } finally {
    await f.connector.creativeJobs.stop();
  }
});

it("refuses changed stored bytes after an uncertain upload instead of replacing the approved image", async () => {
  const f = await fixture();
  try {
    f.loseReferenceResponse();
    await f.execute();
    const changed = new Uint8Array(image);
    changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
    f.blobs.get = vi.fn(async () => changed);
    const restored = f.rebuild();
    await expect(restored.creativeJobs.poll(String(f.effects[0]!.id))).rejects.toMatchObject({
      code: "operation_conflict",
    });
    expect(f.referenceUploads).toHaveLength(1);
    expect(f.putCount()).toBe(0);
    await restored.creativeJobs.stop();
  } finally {
    await f.connector.creativeJobs.stop();
  }
});

it.each(["userId", "spaceId", "botId", "groupId"] as const)(
  "rejects an attachment from another %s before upload",
  async (field) => {
    const f = await fixture();
    f.artifacts[0]![field] = "other";
    try {
      expect(await f.execute()).toMatchObject([
        { type: "error", message: "Creative app: not_found" },
      ]);
      expect(f.referenceUploads).toHaveLength(0);
      expect(f.putCount()).toBe(0);
      expect(f.effects).toHaveLength(0);
    } finally {
      await f.connector.creativeJobs.stop();
    }
  },
);

it("enforces the returned byte limit, per-model count and input capability", async () => {
  const f = await fixture();
  try {
    f.setCatalog(directory(image.byteLength - 1));
    expect(await f.execute()).toMatchObject([
      { type: "error", message: "Creative app: reference_image_too_large" },
    ]);
    expect(f.blobs.get).not.toHaveBeenCalled();
    f.setCatalog(directory());
    expect(
      await f.execute({ ...f.input, referenceArtifactIds: ["source-a", "source-a", "source-a"] }),
    ).toMatchObject([{ type: "error", message: "Creative app: invalid_parameters" }]);
    expect(
      await f.execute({
        ...f.input,
        kind: "video",
        model: "demo-video",
        preset: "demo-video-default",
      }),
    ).toMatchObject([{ type: "error", message: "Creative app: invalid_parameters" }]);
    expect(f.referenceUploads).toHaveLength(0);
    expect(f.putCount()).toBe(0);
    expect(
      creativeToolInputSchema.safeParse({
        ...f.input,
        references: ["https://example.test/image.png"],
      }).success,
    ).toBe(false);
  } finally {
    await f.connector.creativeJobs.stop();
  }
});

it("does not submit a corrupted or non-image attachment and stops if the original run is cancelled during upload", async () => {
  const f = await fixture();
  try {
    f.blobs.get = vi.fn(async () => new Uint8Array(image.byteLength));
    expect(await f.execute()).toMatchObject([
      { type: "error", message: "Creative app: unsupported_media" },
    ]);
    expect(f.putCount()).toBe(0);
  } finally {
    await f.connector.creativeJobs.stop();
  }
  const cancelled = await fixture();
  try {
    const upload = vi
      .spyOn(cancelled.provider, "uploadReference")
      .mockImplementation(async (_user, bytes) => {
        cancelled.runs[0]!.status = "cancelled";
        return {
          id: "00000000-0000-4000-8000-000000000001",
          mimeType: "image/png",
          bytes: bytes.byteLength,
          width: 1,
          height: 1,
        };
      });
    expect(await cancelled.execute()).toMatchObject([
      { type: "error", message: "Creative app: forbidden" },
    ]);
    expect(cancelled.putCount()).toBe(0);
    upload.mockRestore();
  } finally {
    await cancelled.connector.creativeJobs.stop();
  }
});
