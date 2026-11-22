import type { AdapterContext } from "@rakazo/adapter-kit";
import { ATTACHMENT_MAX_BASE64_LENGTH, ATTACHMENT_MAX_BYTES } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { OpenAIMediaGenerationProvider } from "./openai-media.js";

const context: AdapterContext = {
  spaceId: "space",
  userId: "owner",
  operationId: "op",
  traceId: "trace",
  signal: new AbortController().signal,
};
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0, 16];
const WEBP = [...Buffer.from("RIFF"), 4, 0, 0, 0, ...Buffer.from("WEBPVP8 ")];
const GIF = [...Buffer.from("GIF89a"), 1, 0];
const b64 = (bytes: number[]) => Buffer.from(bytes).toString("base64");
const image = (bytes: number[]) => ({ created: 1, data: [{ b64_json: b64(bytes) }] });
const json = (value: unknown, init?: ResponseInit) => new Response(JSON.stringify(value), init);
function setup(...responses: Response[]) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const response of responses) fetch.mockResolvedValueOnce(response);
  return {
    fetch,
    provider: new OpenAIMediaGenerationProvider({
      apiKey: "fake-key",
      imageModel: "image-model",
      baseUrl: "https://images.example.test/v1/",
      fetch,
      resolveHostname: async (host) =>
        host === "internal.example.test"
          ? [{ address: "10.0.0.5", family: 4 }]
          : [{ address: "93.184.216.34", family: 4 }],
    }),
  };
}

describe("images API media generation", () => {
  it("sends one generation request and returns the inline image", async () => {
    const { fetch, provider } = setup(json(image(PNG)));
    expect(await provider.generateImage({ prompt: " draw " }, context)).toEqual({
      mimeType: "image/png",
      bytes: new Uint8Array(PNG),
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://images.example.test/v1/images/generations");
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fake-key");
    expect(JSON.parse(init?.body as string)).toEqual({
      model: "image-model",
      prompt: "draw",
      n: 1,
    });
  });
  it("defaults to the vendor endpoint", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json(image(PNG)));
    await new OpenAIMediaGenerationProvider({
      apiKey: "fake-key",
      imageModel: "image-model",
      fetch,
    }).generateImage({ prompt: "draw" }, context);
    expect(fetch.mock.calls[0]![0]).toBe("https://api.openai.com/v1/images/generations");
  });
  it.each([
    ["image/jpeg", JPEG],
    ["image/webp", WEBP],
  ])("reads %s from the image bytes", async (mimeType, bytes) => {
    const { provider } = setup(json(image(bytes)));
    expect(await provider.generateImage({ prompt: "draw" }, context)).toEqual({
      mimeType,
      bytes: new Uint8Array(bytes),
    });
  });
  it.each([
    ["an unsupported format", image(GIF)],
    ["bytes that are not an image", image([...Buffer.from("not an image")])],
    ["base64 with stray characters", { data: [{ b64_json: `${b64(PNG)}@@@@` }] }],
    [
      "base64 with a space inside",
      { data: [{ b64_json: `${b64(PNG).slice(0, 8)} ${b64(PNG).slice(9)}` }] },
    ],
    ["truncated base64", { data: [{ b64_json: b64(PNG).slice(0, -1) }] }],
    ["no images", { data: [] }],
    ["neither inline data nor a link", { data: [{ revised_prompt: "draw" }] }],
  ])("rejects a response with %s", async (_case, body) => {
    const { provider } = setup(json(body));
    await expect(provider.generateImage({ prompt: "draw" }, context)).rejects.toMatchObject({
      code: "provider_failure",
    });
  });
  it("accepts base64 that the server wraps into lines", async () => {
    const { provider } = setup(
      json({ data: [{ b64_json: `${b64(PNG).replace(/(.{8})/g, "$1\n")}\r\n` }] }),
    );
    expect(await provider.generateImage({ prompt: "draw" }, context)).toEqual({
      mimeType: "image/png",
      bytes: new Uint8Array(PNG),
    });
  });
  it("accepts a near-limit image wrapped with CRLF every 76 characters", async () => {
    const bytes = Buffer.alloc(ATTACHMENT_MAX_BYTES);
    Buffer.from(PNG).copy(bytes);
    const wrapped = bytes.toString("base64").replace(/(.{76})/g, "$1\r\n");
    const { provider } = setup(json({ data: [{ b64_json: wrapped }] }));
    const result = await provider.generateImage({ prompt: "draw" }, context);
    expect(result.mimeType).toBe("image/png");
    expect(result.bytes.length).toBe(ATTACHMENT_MAX_BYTES);
  });
  it("keeps a linked image download within the generation deadline", async () => {
    const deadline = new AbortController();
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) =>
      ms === 180_000 ? deadline.signal : realTimeout(ms),
    );
    try {
      const { provider, fetch } = setup(
        json({ data: [{ url: "https://cdn.example.test/image.png" }] }),
        new Response(new Uint8Array(PNG)),
      );
      await provider.generateImage({ prompt: "draw" }, context);
      const downloadSignal = fetch.mock.calls[1]![1]!.signal!;
      expect(downloadSignal.aborted).toBe(false);
      deadline.abort(new Error("deadline"));
      expect(downloadSignal.aborted).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  });
  it("downloads a linked image without sending the API key", async () => {
    const { provider, fetch } = setup(
      json({ data: [{ url: "https://cdn.example.test/image.png" }] }),
      new Response(new Uint8Array(PNG), {
        headers: { "content-type": "application/octet-stream" },
      }),
    );
    expect(await provider.generateImage({ prompt: "draw" }, context)).toEqual({
      mimeType: "image/png",
      bytes: new Uint8Array(PNG),
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    const [url, init] = fetch.mock.calls[1]!;
    expect(String(url)).toBe("https://cdn.example.test/image.png");
    expect(new Headers(init?.headers).get("authorization")).toBeNull();
  });
  it.each([
    ["a private host", "https://internal.example.test/image.png"],
    ["a loopback address", "http://127.0.0.1/image.png"],
  ])("refuses a link to %s", async (_case, url) => {
    const { provider, fetch } = setup(json({ data: [{ url }] }));
    await expect(provider.generateImage({ prompt: "draw" }, context)).rejects.toMatchObject({
      code: "provider_failure",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("refuses a link that redirects", async () => {
    const { provider } = setup(
      json({ data: [{ url: "https://cdn.example.test/image.png" }] }),
      new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } }),
    );
    await expect(provider.generateImage({ prompt: "draw" }, context)).rejects.toMatchObject({
      code: "provider_failure",
    });
  });
  it("rejects a linked file that is not an image", async () => {
    const { provider } = setup(
      json({ data: [{ url: "https://cdn.example.test/image.png" }] }),
      new Response("<html>nope</html>", { headers: { "content-type": "image/png" } }),
    );
    await expect(provider.generateImage({ prompt: "draw" }, context)).rejects.toMatchObject({
      code: "provider_failure",
    });
  });
  it.each([
    [429, "rate_limit"],
    [401, "authentication"],
    [403, "authentication"],
    [400, "provider_failure"],
    [503, "provider_failure"],
  ])("sanitizes HTTP %i without retrying", async (status, code) => {
    const { provider, fetch } = setup(
      new Response("private provider response", { status: Number(status) }),
    );
    await expect(provider.generateImage({ prompt: "draw" }, context)).rejects.toThrow(
      `Media generation: ${code}`,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("sanitizes network errors and malformed responses", async () => {
    const { provider, fetch } = setup();
    fetch.mockRejectedValueOnce(new Error("fake-key private endpoint"));
    await expect(provider.generateImage({ prompt: "draw" }, context)).rejects.toThrow(
      "Media generation: provider_failure",
    );
    fetch.mockResolvedValueOnce(new Response("bad JSON"));
    await expect(provider.generateImage({ prompt: "draw" }, context)).rejects.toThrow(
      "Media generation: provider_failure",
    );
  });
  it("rejects an image over the attachment limit", async () => {
    const { provider } = setup(
      json({ data: [{ b64_json: "A".repeat(ATTACHMENT_MAX_BASE64_LENGTH + 4) }] }),
    );
    await expect(provider.generateImage({ prompt: "draw" }, context)).rejects.toMatchObject({
      code: "output_limit",
    });
  });
  it("stops reading a response body past the limit", async () => {
    const { provider } = setup(new Response(new Uint8Array(ATTACHMENT_MAX_BASE64_LENGTH * 2)));
    await expect(provider.generateImage({ prompt: "draw" }, context)).rejects.toMatchObject({
      code: "output_limit",
    });
  });
  it("rejects invalid prompts and video before HTTP", async () => {
    const { provider, fetch } = setup();
    await expect(provider.generateImage({ prompt: " " }, context)).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(provider.generateVideo()).rejects.toMatchObject({ code: "unsupported" });
    await expect(provider.pollVideo()).rejects.toMatchObject({ code: "unsupported" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("preserves cancellation without making a request", async () => {
    const { provider, fetch } = setup();
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      provider.generateImage({ prompt: "draw" }, { ...context, signal: controller.signal }),
    ).rejects.toThrow("cancelled");
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    ["ftp://images.example.test/v1", "image-model"],
    ["https://user:secret@images.example.test/v1", "image-model"],
    ["https://images.example.test/v1?key=secret", "image-model"],
    ["https://images.example.test/v1", "bad model id"],
  ])("rejects base URL %s with model %s", (baseUrl, imageModel) => {
    expect(
      () => new OpenAIMediaGenerationProvider({ apiKey: "fake-key", imageModel, baseUrl }),
    ).toThrow();
  });
});
