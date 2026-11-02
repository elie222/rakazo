import type { AdapterContext } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OutcrawlWebOptions } from "./outcrawl-web.js";
import { OutcrawlWebProvider } from "./outcrawl-web.js";
import { createWebProvider, resolveWebProviderKind } from "./web-provider-factory.js";
import { webFetchFromTool, webSearchFromTool } from "./web-tools.js";

const context: AdapterContext = {
  operationId: "operation",
  traceId: "trace",
  spaceId: "space",
  userId: "user",
  botId: "bot",
  signal: new AbortController().signal,
};

const publicResolver = async () => [{ address: "203.0.113.10", family: 4 as const }];

type Call = { url: string; headers: Headers; body: Record<string, unknown> };

/** Offline Outcrawl API: answers search and scrape with the given JSON bodies. */
function outcrawlFixture(responses: { search?: unknown; scrape?: unknown; status?: number } = {}) {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? "{}")),
    });
    const data = url.endsWith("/v1/search")
      ? (responses.search ?? {
          hits: [
            {
              url: "https://example.test/page",
              title: "Source",
              snippet: "Useful evidence",
              rank: 1,
            },
          ],
          usage: { credits: "0.5" },
        })
      : (responses.scrape ?? {
          url: "https://example.test/page",
          statusCode: 200,
          markdown: "Page text ".repeat(20),
          metadata: { title: "Source" },
          usage: { credits: "1" },
        });
    return new Response(JSON.stringify(data), {
      status: responses.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, network: { fetch, resolveHostname: publicResolver } };
}

afterEach(() => vi.unstubAllEnvs());

describe("optional Outcrawl web provider", () => {
  it("maps search hits through the selected web tool and sends the key", async () => {
    vi.stubEnv("OUTCRAWL_API_KEY", " synthetic-key ");
    const peer = outcrawlFixture();
    const provider = createWebProvider(
      resolveWebProviderKind({ WEB_PROVIDER: "outcrawl" }),
      peer.network,
    );
    expect(provider.describe().id).toBe("outcrawl");
    expect(
      await webSearchFromTool(provider, context, { query: "current question", maxResults: 1 }),
    ).toEqual({
      results: [{ title: "Source", url: "https://example.test/page", snippet: "Useful evidence" }],
    });
    expect(peer.calls).toHaveLength(1);
    const [call] = peer.calls;
    expect(call?.url).toBe("https://api.outcrawl.ai/v1/search");
    expect(call?.body).toEqual({ query: "current question", limit: 1 });
    expect(call?.headers.get("authorization")).toBe("Bearer synthetic-key");
    expect(call?.headers.get("user-agent")).toBe(
      "Rakazo/0.1 (+https://github.com/elie222/rakazo; web tools)",
    );
  });

  it("asks for a key before sending anything", async () => {
    vi.stubEnv("OUTCRAWL_API_KEY", "");
    const peer = outcrawlFixture();
    expect(
      await webSearchFromTool(new OutcrawlWebProvider(peer.network), context, { query: "q" }),
    ).toEqual({ error: "Outcrawl: set OUTCRAWL_API_KEY on the API and worker" });
    expect(peer.calls).toEqual([]);
  });

  it("maps page markdown and caps content at the requested size", async () => {
    vi.stubEnv("OUTCRAWL_API_KEY", "synthetic-key");
    const peer = outcrawlFixture();
    expect(
      await webFetchFromTool(new OutcrawlWebProvider(peer.network), context, {
        url: "https://example.test/page",
        maxChars: 100,
      }),
    ).toEqual({
      title: "Source",
      url: "https://example.test/page",
      text: `${"Page text ".repeat(10)}\n\n[Content truncated; continue with offset 100]`,
      truncated: true,
    });
    expect(peer.calls[0]?.url).toBe("https://api.outcrawl.ai/v1/scrape");
    expect(peer.calls[0]?.body).toEqual({
      url: "https://example.test/page",
      formats: ["markdown"],
      onlyMainContent: true,
    });
  });

  it("reads on from an offset", async () => {
    vi.stubEnv("OUTCRAWL_API_KEY", "synthetic-key");
    const peer = outcrawlFixture({
      scrape: { statusCode: 200, markdown: `head${"a".repeat(200)}`, metadata: {} },
    });
    expect(
      await webFetchFromTool(new OutcrawlWebProvider(peer.network), context, {
        url: "https://example.test/page",
        maxChars: 8_000,
        offset: 4,
      }),
    ).toEqual({
      title: "https://example.test/page",
      url: "https://example.test/page",
      text: "a".repeat(200),
      truncated: false,
    });
  });

  it("refuses a private page URL before disclosing it", async () => {
    vi.stubEnv("OUTCRAWL_API_KEY", "synthetic-key");
    const peer = outcrawlFixture();
    const result = await webFetchFromTool(new OutcrawlWebProvider(peer.network), context, {
      url: "http://127.0.0.1/admin",
    });
    expect(result).toHaveProperty("error");
    expect(peer.calls).toEqual([]);
  });

  it("returns page errors, empty pages and API errors to the bot", async () => {
    vi.stubEnv("OUTCRAWL_API_KEY", "synthetic-key");
    const read = (peer: { network: OutcrawlWebOptions }) =>
      webFetchFromTool(new OutcrawlWebProvider(peer.network), context, {
        url: "https://example.test/page",
      });
    expect(
      await read(outcrawlFixture({ scrape: { statusCode: 404, markdown: "Not found" } })),
    ).toEqual({ error: "Outcrawl: the page returned HTTP 404" });
    expect(await read(outcrawlFixture({ scrape: { statusCode: 200, markdown: " \n" } }))).toEqual({
      error: "Outcrawl returned empty page content",
    });
    expect(
      await read(outcrawlFixture({ status: 402, scrape: { error: "Out of credits" } })),
    ).toEqual({ error: 'Outcrawl scrape failed (402): {"error":"Out of credits"}' });
    expect(await read(outcrawlFixture({ scrape: { markdown: 42 } }))).toEqual({
      error: "Invalid Outcrawl response",
    });
  });

  it("bounds snippets and result counts and keeps only public citations", async () => {
    vi.stubEnv("OUTCRAWL_API_KEY", "synthetic-key");
    const peer = outcrawlFixture({
      search: {
        hits: [
          { url: "javascript:alert(1)", title: "Script", snippet: "x" },
          { url: "https://user:pass@example.test/secret", title: "Credentials", snippet: "x" },
          { url: "https://example.test/a", title: "", snippet: "s".repeat(9_000) },
          { url: "https://example.test/b", title: "B", snippet: null },
          { url: "https://example.test/c", title: "C", snippet: "c" },
        ],
      },
    });
    const results = await new OutcrawlWebProvider(peer.network).search(
      { query: "q", maxResults: 2 },
      context,
    );
    expect(results).toEqual([
      {
        url: "https://example.test/a",
        title: "https://example.test/a",
        snippet: "s".repeat(8_000),
      },
      { url: "https://example.test/b", title: "B", snippet: "" },
    ]);
  });
});
