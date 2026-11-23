import type { AdapterContext } from "@rakazo/adapter-kit";
import { ATTACHMENT_MAX_BYTES } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { OpenRouterMediaGenerationProvider } from "./openrouter-media.js";

const context: AdapterContext = {
  spaceId: "space",
  userId: "owner",
  operationId: "op",
  traceId: "trace",
  signal: new AbortController().signal,
};
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];
const MP4 = new TextEncoder().encode("fake mp4");
const json = (value: unknown, init?: ResponseInit) => new Response(JSON.stringify(value), init);
const mp4 = (body: BodyInit = MP4, type = "video/mp4") =>
  new Response(body, { headers: { "content-type": type } });
function setup(
  models: { imageModel?: string; videoModel?: string } = {
    imageModel: "image/model",
    videoModel: "video/model",
  },
  ...responses: Response[]
) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const response of responses) fetch.mockResolvedValueOnce(response);
  return {
    fetch,
    provider: new OpenRouterMediaGenerationProvider({ apiKey: "fake-key", ...models, fetch }),
  };
}
const both = { imageModel: "image/model", videoModel: "video/model" };

describe("OpenRouter media generation", () => {
  it("generates one image through the images endpoint", async () => {
    const { fetch, provider } = setup(
      both,
      json({ data: [{ b64_json: Buffer.from(PNG).toString("base64"), media_type: "image/png" }] }),
    );
    expect(await provider.generateImage({ prompt: "draw" }, context)).toEqual({
      mimeType: "image/png",
      bytes: new Uint8Array(PNG),
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://openrouter.ai/api/v1/images");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fake-key");
    expect(JSON.parse(init?.body as string)).toEqual({
      model: "image/model",
      prompt: "draw",
      n: 1,
    });
  });
  it("submits a four-second video job", async () => {
    const { fetch, provider } = setup(
      both,
      json(
        { id: "job-1", polling_url: "/api/v1/videos/job-1", status: "pending" },
        { status: 202 },
      ),
    );
    expect(await provider.generateVideo({ prompt: "move" }, context)).toEqual({
      id: "job-1",
      status: "queued",
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://openrouter.ai/api/v1/videos");
    expect(JSON.parse(init?.body as string)).toEqual({
      model: "video/model",
      prompt: "move",
      duration: 4,
    });
  });
  it("asks for no-retention endpoints on images and videos when the connection does", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    fetch
      .mockResolvedValueOnce(json({ data: [{ b64_json: Buffer.from(PNG).toString("base64") }] }))
      .mockResolvedValueOnce(json({ id: "job-1", status: "pending" }, { status: 202 }));
    const provider = new OpenRouterMediaGenerationProvider({
      apiKey: "fake-key",
      ...both,
      zeroDataRetention: true,
      fetch,
    });
    await provider.generateImage({ prompt: "draw" }, context);
    await provider.generateVideo({ prompt: "move" }, context);
    for (const [, init] of fetch.mock.calls)
      expect(JSON.parse(init?.body as string)).toMatchObject({ provider: { zdr: true } });
  });
  it("reports progress while the job runs", async () => {
    const { fetch, provider } = setup(
      both,
      json({
        id: "job-1",
        polling_url: "/api/v1/videos/job-1",
        status: "in_progress",
        progress: 40,
      }),
    );
    expect(await provider.pollVideo("job-1", context)).toEqual({
      id: "job-1",
      status: "running",
      progress: 40,
    });
    expect(fetch.mock.calls[0]![0]).toBe("https://openrouter.ai/api/v1/videos/job-1");
  });
  it("downloads a finished video from the job's content endpoint", async () => {
    const { fetch, provider } = setup(
      both,
      json({
        id: "job-1",
        polling_url: "/api/v1/videos/job-1",
        status: "completed",
        unsigned_urls: ["https://storage.example.test/video.mp4"],
      }),
      mp4(),
    );
    expect(await provider.pollVideo("job-1", context)).toEqual({
      id: "job-1",
      status: "completed",
      output: { mimeType: "video/mp4", bytes: MP4 },
    });
    const [url, init] = fetch.mock.calls[1]!;
    expect(url).toBe("https://openrouter.ai/api/v1/videos/job-1/content?index=0");
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fake-key");
  });
  it("reports what an image cost", async () => {
    const image = setup(
      both,
      json({ data: [{ b64_json: Buffer.from(PNG).toString("base64") }], usage: { cost: 0.039 } }),
    );
    expect(await image.provider.generateImage({ prompt: "draw" }, context)).toMatchObject({
      costMicros: 39_000,
    });
  });
  it("reports what a finished video cost", async () => {
    const video = setup(
      both,
      json({ id: "job-1", status: "completed", usage: { cost: 0.2, is_byok: false } }),
      mp4(),
    );
    expect(await video.provider.pollVideo("job-1", context)).toMatchObject({
      output: { costMicros: 200_000 },
    });
  });
  it.each(["failed", "cancelled", "expired"])("reports a %s job as failed", async (status) => {
    const { provider } = setup(
      both,
      json({ id: "job-1", polling_url: "/api/v1/videos/job-1", status, error: "policy" }),
    );
    expect(await provider.pollVideo("job-1", context)).toEqual({ id: "job-1", status: "failed" });
  });
  it.each([
    ["a file that is not an MP4", mp4("<html>", "text/html"), "provider_failure"],
    [
      "a video over the attachment limit",
      mp4(new Uint8Array(ATTACHMENT_MAX_BYTES + 1)),
      "output_limit",
    ],
  ])("rejects %s", async (_case, download, code) => {
    const { provider } = setup(
      both,
      json({ id: "job-1", polling_url: "/api/v1/videos/job-1", status: "completed" }),
      download,
    );
    await expect(provider.pollVideo("job-1", context)).rejects.toMatchObject({ code });
  });
  it("rejects a poll answer for another job", async () => {
    const { provider } = setup(
      both,
      json({ id: "job-2", polling_url: "/api/v1/videos/job-2", status: "pending" }),
    );
    await expect(provider.pollVideo("job-1", context)).rejects.toMatchObject({
      code: "provider_failure",
    });
  });
  it.each([
    [429, "rate_limit"],
    [401, "authentication"],
    [502, "provider_failure"],
  ])("sanitizes HTTP %i", async (status, code) => {
    const { provider } = setup(both, new Response("private provider response", { status }));
    await expect(provider.generateVideo({ prompt: "move" }, context)).rejects.toThrow(
      `Media generation: ${code}`,
    );
  });
  it("refuses unconfigured kinds and bad input before HTTP", async () => {
    const { fetch, provider } = setup({ videoModel: "video/model" });
    expect(provider.capabilities).toEqual({ images: false, video: true, offline: false });
    await expect(provider.generateImage({ prompt: "draw" }, context)).rejects.toMatchObject({
      code: "unsupported",
    });
    await expect(provider.generateVideo({ prompt: " " }, context)).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(provider.pollVideo("../keys", context)).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
