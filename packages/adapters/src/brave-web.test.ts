import type { AdapterContext } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { BraveWebProvider } from "./brave-web.js";

const ctx: AdapterContext = {
  operationId: "1",
  traceId: "1",
  spaceId: "w",
  userId: "u",
  signal: new AbortController().signal,
};

const publicResolver = async () => [{ address: "203.0.113.10", family: 4 as const }];

const searchBody = {
  web: {
    results: [
      { url: "https://example.test/a", title: "Alpha", description: "Alpha snippet" },
      { url: "https://example.test/b", title: "Beta", description: "Beta snippet" },
      { url: "ftp://example.test/c", title: "Skipped", description: "not http" },
    ],
  },
};

describe("Brave web provider", () => {
  it("describes itself as a keyed provider", () => {
    const provider = new BraveWebProvider({ apiKey: "brave-test" });
    expect(provider.describe().id).toBe("brave");
    expect(provider.describe().capabilities.keyless).toBe(false);
    expect(provider.describe().capabilities.search).toBe(true);
    expect(provider.describe().capabilities.fetch).toBe(true);
  });

  it("searches through the Brave API and drops non-http hits", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const provider = new BraveWebProvider({
      apiKey: "brave-test",
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        seen.push({
          url: String(input),
          headers: Object.fromEntries(new Headers(init?.headers).entries()),
        });
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
    expect(seen[0]?.url).toContain("https://api.search.brave.com/res/v1/web/search");
    expect(seen[0]?.url).toContain("q=alpha");
    expect(seen[0]?.headers["x-subscription-token"]).toBe("brave-test");
  });

  it("refuses to search without an API key", async () => {
    const provider = new BraveWebProvider({ apiKey: "" });
    await expect(provider.search({ query: "alpha", maxResults: 5 }, ctx)).rejects.toThrow(
      "Brave API key is not configured",
    );
  });

  it("reports an HTTP failure without leaking the key", async () => {
    const provider = new BraveWebProvider({
      apiKey: "brave-test",
      fetch: (async () => new Response("nope", { status: 401 })) as typeof fetch,
    });
    await expect(provider.search({ query: "alpha", maxResults: 5 }, ctx)).rejects.toThrow(
      "Brave search failed: HTTP 401",
    );
  });

  it("fetches a page directly with readability extraction", async () => {
    const html =
      "<html><head><title>Alpha page</title></head><body><article><p>Alpha body text</p></article></body></html>";
    const provider = new BraveWebProvider({
      apiKey: "brave-test",
      fetch: (async () =>
        new Response(html, { headers: { "content-type": "text/html" } })) as typeof fetch,
      resolveHostname: publicResolver,
    });
    const page = await provider.fetch({ url: "https://example.test/a", maxChars: 500 }, ctx);
    expect(page.url).toBe("https://example.test/a");
    expect(page.title).toBe("Alpha page");
    expect(page.text).toContain("Alpha body text");
    expect(page.truncated).toBe(false);
  });
});
