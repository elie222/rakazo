import type { AdapterContext } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { TavilyWebProvider } from "./tavily-web.js";

const ctx: AdapterContext = {
  operationId: "1",
  traceId: "1",
  spaceId: "w",
  userId: "u",
  signal: new AbortController().signal,
};

const searchBody = {
  results: [
    { url: "https://example.test/a", title: "Alpha", content: "Alpha snippet" },
    { url: "https://example.test/b", title: "Beta", content: "Beta snippet" },
    { url: "ftp://example.test/c", title: "Skipped", content: "not http" },
  ],
};

const extractBody = {
  results: [{ url: "https://example.test/a", title: "Alpha", raw_content: "Alpha body text" }],
  failed_results: [],
};

describe("Tavily web provider", () => {
  it("describes itself as a keyed provider", () => {
    const provider = new TavilyWebProvider({ apiKey: "tvly-test" });
    expect(provider.describe().id).toBe("tavily");
    expect(provider.describe().capabilities.keyless).toBe(false);
    expect(provider.describe().capabilities.search).toBe(true);
    expect(provider.describe().capabilities.fetch).toBe(true);
  });

  it("searches through the Tavily API and drops non-http hits", async () => {
    const seen: { url: string; body: unknown }[] = [];
    const provider = new TavilyWebProvider({
      apiKey: "tvly-test",
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        seen.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) });
        return new Response(JSON.stringify(searchBody), {
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });
    await expect(provider.search({ query: "alpha", maxResults: 5 }, ctx)).resolves.toEqual([
      { url: "https://example.test/a", title: "Alpha", snippet: "Alpha snippet" },
      { url: "https://example.test/b", title: "Beta", snippet: "Beta snippet" },
    ]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("https://api.tavily.com/search");
    expect(seen[0]?.body).toMatchObject({ query: "alpha", max_results: 5 });
    // The key travels in the request body, never in an error message.
    expect(JSON.stringify(seen[0]?.body)).toContain("tvly-test");
  });

  it("refuses to search without an API key", async () => {
    const provider = new TavilyWebProvider({ apiKey: "" });
    await expect(provider.search({ query: "alpha", maxResults: 5 }, ctx)).rejects.toThrow(
      "Tavily API key is not configured",
    );
  });

  it("reports an HTTP failure without leaking the key", async () => {
    const provider = new TavilyWebProvider({
      apiKey: "tvly-test",
      fetch: (async () => new Response("nope", { status: 401 })) as typeof fetch,
    });
    await expect(provider.search({ query: "alpha", maxResults: 5 }, ctx)).rejects.toThrow(
      "Tavily search failed: HTTP 401",
    );
  });

  it("extracts a page through the Tavily API", async () => {
    const provider = new TavilyWebProvider({
      apiKey: "tvly-test",
      fetch: (async (input: string | URL | Request) => {
        expect(String(input)).toBe("https://api.tavily.com/extract");
        return new Response(JSON.stringify(extractBody), {
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });
    await expect(
      provider.fetch({ url: "https://example.test/a", maxChars: 500 }, ctx),
    ).resolves.toEqual({
      url: "https://example.test/a",
      title: "Alpha",
      text: "Alpha body text",
      truncated: false,
    });
  });

  it("throws when the extract returns no content", async () => {
    const provider = new TavilyWebProvider({
      apiKey: "tvly-test",
      fetch: (async () =>
        new Response(JSON.stringify({ results: [], failed_results: [] }), {
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    });
    await expect(
      provider.fetch({ url: "https://example.test/a", maxChars: 500 }, ctx),
    ).rejects.toThrow("Tavily extract returned no content");
  });
});
