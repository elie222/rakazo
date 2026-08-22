import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isSupermemoryEnabled,
  MAX_MEMORY_CONTENT_CHARS,
  MAX_RECALLED_MEMORIES,
  saveSupermemoryMemory,
  searchSupermemory,
  supermemoryContainerTag,
} from "./supermemory-client.js";

describe("supermemory client", () => {
  const previousApiKey = process.env.SUPERMEMORY_API_KEY;
  const previousBaseUrl = process.env.SUPERMEMORY_API_URL;

  beforeEach(() => {
    process.env.SUPERMEMORY_API_KEY = "sm_test_key";
    process.env.SUPERMEMORY_API_URL = "http://localhost:6767";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (previousApiKey === undefined) delete process.env.SUPERMEMORY_API_KEY;
    else process.env.SUPERMEMORY_API_KEY = previousApiKey;
    if (previousBaseUrl === undefined) delete process.env.SUPERMEMORY_API_URL;
    else process.env.SUPERMEMORY_API_URL = previousBaseUrl;
  });

  describe("supermemoryContainerTag", () => {
    it("scopes the tag to the bot id", () => {
      expect(supermemoryContainerTag("bot-123")).toBe("rakazo:bot-123");
      expect(supermemoryContainerTag("bot-123", 2)).toBe("rakazo:bot-123:history:2");
    });
  });

  describe("searchSupermemory", () => {
    it("reports when Supermemory is not configured", async () => {
      delete process.env.SUPERMEMORY_API_KEY;
      const result = await searchSupermemory("voice of customer", "rakazo:bot-123");
      expect(result).toEqual({ ok: false, error: expect.stringContaining("not configured") });
    });

    it("posts the query and container tag, returning search results on success", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            results: [{ memory: "User prefers British English", similarity: 0.9 }],
          }),
          { status: 200 },
        ),
      );
      vi.stubGlobal("fetch", fetchMock);

      const result = await searchSupermemory("spelling preference", "rakazo:bot-123");

      expect(result).toEqual({
        ok: true,
        results: [{ memory: "User prefers British English", similarity: 0.9 }],
      });
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe("http://localhost:6767/v4/search");
      expect(init.headers.Authorization).toBe("Bearer sm_test_key");
      expect(JSON.parse(init.body)).toStrictEqual({
        q: "spelling preference",
        containerTag: "rakazo:bot-123",
        searchMode: "memories",
        limit: MAX_RECALLED_MEMORIES,
      });
    });

    it("reports a non-OK response instead of throwing", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 500 })));
      const result = await searchSupermemory("anything", "rakazo:bot-123");
      expect(result).toEqual({ ok: false, error: expect.stringContaining("500") });
    });

    it("reports an unreachable server instead of throwing", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")));
      const result = await searchSupermemory("anything", "rakazo:bot-123");
      expect(result).toEqual({ ok: false, error: expect.stringContaining("unreachable") });
    });

    it("treats document chunks as memory text when the search result has no memory field", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ results: [{ chunk: "Older decision: use Postgres." }] }), {
            status: 200,
          }),
        ),
      );

      const result = await searchSupermemory("database", "rakazo:bot-123");

      expect(result).toEqual({
        ok: true,
        results: [{ memory: "Older decision: use Postgres.", similarity: 0 }],
      });
    });

    it("drops malformed search hits instead of injecting empty memories", async () => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(
            new Response(
              JSON.stringify({ results: [{}, { memory: "  " }, "nope", { memory: "kept" }] }),
              { status: 200 },
            ),
          ),
      );

      const result = await searchSupermemory("anything", "rakazo:bot-123");

      expect(result).toEqual({ ok: true, results: [{ memory: "kept", similarity: 0 }] });
    });

    it("defaults to the hosted Supermemory API when SUPERMEMORY_API_URL is unset", async () => {
      delete process.env.SUPERMEMORY_API_URL;
      const fetchMock = vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ results: [] }), { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      await searchSupermemory("anything", "rakazo:bot-123");

      expect(fetchMock.mock.calls[0]![0]).toBe("https://api.supermemory.ai/v4/search");
    });
  });

  describe("saveSupermemoryMemory", () => {
    it("reports when Supermemory is not configured", async () => {
      delete process.env.SUPERMEMORY_API_KEY;
      const result = await saveSupermemoryMemory("fact", "rakazo:bot-123");
      expect(result).toEqual({ ok: false, error: expect.stringContaining("not configured") });
    });

    it("posts the content and container tag on success", async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      const result = await saveSupermemoryMemory("User prefers British English", "rakazo:bot-123");

      expect(result).toEqual({ ok: true });
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe("http://localhost:6767/v4/memories");
      expect(JSON.parse(init.body)).toEqual({
        containerTag: "rakazo:bot-123",
        memories: [{ content: "User prefers British English", isStatic: false }],
      });
    });

    it("caps oversized content at the API limit", async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      await saveSupermemoryMemory(
        `prefix ${"x".repeat(MAX_MEMORY_CONTENT_CHARS)}`,
        "rakazo:bot-123",
      );

      const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
      expect(body.memories[0].content).toHaveLength(MAX_MEMORY_CONTENT_CHARS);
    });

    it("reports a non-OK response instead of throwing", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })));
      const result = await saveSupermemoryMemory("fact", "rakazo:bot-123");
      expect(result).toEqual({ ok: false, error: expect.stringContaining("401") });
    });
  });

  describe("isSupermemoryEnabled", () => {
    it("is false when no API key is set", () => {
      expect(isSupermemoryEnabled(undefined)).toBe(false);
      expect(isSupermemoryEnabled("")).toBe(false);
    });

    it("is true when an API key is set", () => {
      expect(isSupermemoryEnabled("sm_test_key")).toBe(true);
    });

    it("is false for whitespace-only keys", () => {
      expect(isSupermemoryEnabled("   ")).toBe(false);
    });
  });
});
