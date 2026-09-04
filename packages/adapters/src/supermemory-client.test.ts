import { describe, expect, it, vi } from "vitest";
import {
  deleteSupermemoryContainer,
  MAX_MEMORY_CONTENT_CHARS,
  MAX_RECALLED_MEMORIES,
  MAX_SUPERMEMORY_RESPONSE_BYTES,
  probeSupermemory,
  saveSupermemoryMemory,
  saveSupermemoryMemoryToContainers,
  searchSupermemory,
  searchSupermemoryContainers,
} from "./supermemory-client.js";

const config = { baseUrl: "http://localhost:6767", apiKey: "sm_test_key" };

describe("searchSupermemory", () => {
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

    const result = await searchSupermemory("spelling preference", "rakazo:bot-123", config);

    expect(result).toEqual({
      ok: true,
      results: [{ memory: "User prefers British English", similarity: 0.9 }],
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://localhost:6767/v4/search");
    expect(init.headers.Authorization).toBe("Bearer sm_test_key");
    expect(init.redirect).toBe("error");
    expect(JSON.parse(init.body)).toStrictEqual({
      q: "spelling preference",
      containerTag: "rakazo:bot-123",
      searchMode: "memories",
      limit: MAX_RECALLED_MEMORIES,
    });
    vi.unstubAllGlobals();
  });

  it("reports a non-OK response instead of throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 500 })));
    const result = await searchSupermemory("anything", "rakazo:bot-123", config);
    expect(result).toEqual({ ok: false, error: expect.stringContaining("500") });
    vi.unstubAllGlobals();
  });

  it("reports an unreachable server instead of throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")));
    const result = await searchSupermemory("anything", "rakazo:bot-123", config);
    expect(result).toEqual({ ok: false, error: expect.stringContaining("unreachable") });
    vi.unstubAllGlobals();
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

    const result = await searchSupermemory("database", "rakazo:bot-123", config);

    expect(result).toEqual({
      ok: true,
      results: [{ memory: "Older decision: use Postgres.", similarity: 0 }],
    });
    vi.unstubAllGlobals();
  });

  it("drops malformed search hits instead of injecting empty memories", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ results: [{}, { memory: "  " }, "nope", { memory: "kept" }] }),
          {
            status: 200,
          },
        ),
      ),
    );

    const result = await searchSupermemory("anything", "rakazo:bot-123", config);

    expect(result).toEqual({ ok: true, results: [{ memory: "kept", similarity: 0 }] });
    vi.unstubAllGlobals();
  });

  it("bounds each recalled memory to the provider content limit", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ results: [{ memory: `kept${"x".repeat(20_000)}` }] })),
        ),
    );

    const result = await searchSupermemory("anything", "rakazo:bot-123", config);

    expect(result.ok && result.results[0]?.memory).toHaveLength(MAX_MEMORY_CONTENT_CHARS);
    vi.unstubAllGlobals();
  });

  it("rejects an oversized search response before buffering it", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({
          "content-length": String(MAX_SUPERMEMORY_RESPONSE_BYTES + 1),
        }),
        body: { cancel },
      }),
    );

    const result = await searchSupermemory("anything", "rakazo:bot-123", config);

    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining("response is too large"),
    });
    expect(cancel).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it("caps a chunked search response without a content length", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(new Uint8Array(MAX_SUPERMEMORY_RESPONSE_BYTES + 1))),
    );

    const result = await searchSupermemory("anything", "rakazo:bot-123", config);

    expect(result).toEqual({ ok: false, error: "Supermemory response is too large." });
    vi.unstubAllGlobals();
  });
});

describe("searchSupermemoryContainers", () => {
  it("deduplicates and ranks results from shared and bot containers", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ results: [{ memory: "shared", similarity: 0.7 }] }), {
            status: 200,
          }),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              results: [
                { memory: "private", similarity: 0.9 },
                { memory: "shared", similarity: 0.6 },
              ],
            }),
            { status: 200 },
          ),
        ),
    );

    await expect(
      searchSupermemoryContainers("query", ["rakazo:workspace:ws-1", "rakazo:bot-1"], config),
    ).resolves.toEqual({
      ok: true,
      results: [
        { memory: "private", similarity: 0.9 },
        { memory: "shared", similarity: 0.7 },
      ],
    });
    vi.unstubAllGlobals();
  });
});

describe("saveSupermemoryMemory", () => {
  it("posts the content and container tag on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await saveSupermemoryMemory(
      "User prefers British English",
      "rakazo:bot-123",
      config,
    );

    expect(result).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://localhost:6767/v4/memories");
    expect(init.redirect).toBe("error");
    expect(JSON.parse(init.body)).toEqual({
      containerTag: "rakazo:bot-123",
      memories: [{ content: "User prefers British English", isStatic: false }],
    });
    vi.unstubAllGlobals();
  });

  it("caps oversized content at the API limit", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await saveSupermemoryMemory(
      `prefix ${"x".repeat(MAX_MEMORY_CONTENT_CHARS)}`,
      "rakazo:bot-123",
      config,
    );

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.memories[0].content).toHaveLength(MAX_MEMORY_CONTENT_CHARS);
    vi.unstubAllGlobals();
  });

  it("reports a non-OK response instead of throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })));
    const result = await saveSupermemoryMemory("fact", "rakazo:bot-123", config);
    expect(result).toEqual({ ok: false, error: expect.stringContaining("401") });
    vi.unstubAllGlobals();
  });
});

describe("saveSupermemoryMemoryToContainers", () => {
  it("writes shared memories to both the workspace and bot containers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      saveSupermemoryMemoryToContainers("fact", ["rakazo:workspace:ws-1", "rakazo:bot-1"], config),
    ).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });
});

describe("deleteSupermemoryContainer", () => {
  it("deletes the container tag on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await deleteSupermemoryContainer("rakazo:bot-123", config);

    expect(result).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://localhost:6767/v3/container-tags/rakazo%3Abot-123");
    expect(init.method).toBe("DELETE");
    expect(init.redirect).toBe("error");
    vi.unstubAllGlobals();
  });

  it("reports a non-OK response instead of throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 404 })));
    const result = await deleteSupermemoryContainer("rakazo:bot-123", config);
    expect(result).toEqual({ ok: false, error: expect.stringContaining("404") });
    vi.unstubAllGlobals();
  });
});

describe("probeSupermemory", () => {
  it("succeeds when the container-tags endpoint responds", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await probeSupermemory(config);
    expect(result).toEqual({ ok: true });
    expect(fetchMock.mock.calls[0]![1].redirect).toBe("error");
    vi.unstubAllGlobals();
  });

  it("fails when the endpoint rejects the key", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })));
    const result = await probeSupermemory(config);
    expect(result).toEqual({ ok: false, error: expect.stringContaining("401") });
    vi.unstubAllGlobals();
  });

  it("fails when nothing is listening", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")));
    const result = await probeSupermemory(config);
    expect(result).toEqual({ ok: false, error: expect.stringContaining("unreachable") });
    vi.unstubAllGlobals();
  });
});
