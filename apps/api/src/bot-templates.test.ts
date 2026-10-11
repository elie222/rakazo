import { afterEach, describe, expect, it, vi } from "vitest";
import { createBotTemplateCatalog } from "./bot-templates.js";

const listing = (slug: string, extra: Record<string, unknown> = {}) => ({
  slug,
  name: slug,
  prompt: "Ask me which folders to organize, then save this setup.",
  ...extra,
});
const response = (bots: unknown[]) => new Response(JSON.stringify({ bots }));

afterEach(() => {
  vi.useRealTimers();
});

describe("bot templates", () => {
  it("fetches once for concurrent requests, caches for an hour, and refreshes on expiry", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockImplementation(async () => response([listing("helper")]));
    const catalog = createBotTemplateCatalog(fetch);
    const [first, second] = await Promise.all([catalog(), catalog()]);
    expect(first).toEqual(second);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 - 1);
    expect(await catalog()).toEqual(first);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await catalog();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.botdirectory.ai/api/bots",
      expect.objectContaining({ redirect: "error", signal: expect.any(AbortSignal) }),
    );
  });

  it("skips null, blank, invalid and duplicate prompts without truncating instructions", async () => {
    const instructions = "x".repeat(5000);
    const catalog = createBotTemplateCatalog(
      vi
        .fn()
        .mockResolvedValue(
          response([
            listing("valid", { prompt: instructions }),
            listing("valid"),
            listing("null", { prompt: null }),
            listing("blank", { prompt: " " }),
            listing("long", { prompt: "x".repeat(20001) }),
            listing("name", { name: "x".repeat(81) }),
            null,
          ]),
        ),
    );
    expect(await catalog()).toEqual([
      { slug: "valid", name: "valid", instructions, description: "", featured: true },
    ]);
  });

  it("uses directory featured flags when provided", async () => {
    const catalog = createBotTemplateCatalog(
      vi
        .fn()
        .mockResolvedValue(
          response([listing("websiteaudit"), listing("other", { featured: true })]),
        ),
    );
    expect((await catalog()).filter((bot) => bot.featured).map((bot) => bot.slug)).toEqual([
      "other",
    ]);
  });

  it("features the first eight listings when the directory has no featured flags", async () => {
    const catalog = createBotTemplateCatalog(
      vi
        .fn()
        .mockResolvedValue(response(Array.from({ length: 10 }, (_, i) => listing(`helper-${i}`)))),
    );
    expect((await catalog()).filter((bot) => bot.featured).map((bot) => bot.slug)).toEqual(
      Array.from({ length: 8 }, (_, i) => `helper-${i}`),
    );
  });

  it.each([
    new Response("down", { status: 503 }),
    new Response("invalid"),
    new Response('{"bots":null}'),
    new Response("x".repeat(1_000_001)),
  ])("hides unavailable or invalid catalogs and backs off before retrying", async (failure) => {
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(failure)
      .mockImplementation(async () => response([listing("helper")]));
    const catalog = createBotTemplateCatalog(fetch);
    expect(await catalog()).toEqual([]);
    expect(await catalog()).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await catalog()).toHaveLength(1);
  });

  it("drops stale listings if refreshing fails, then recovers", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response([listing("helper")]))
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementation(async () => response([listing("helper")]));
    const catalog = createBotTemplateCatalog(fetch);
    expect(await catalog()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(await catalog()).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await catalog()).toHaveLength(1);
  });
});
