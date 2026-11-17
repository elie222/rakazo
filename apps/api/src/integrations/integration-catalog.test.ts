import { describe, expect, it, vi } from "vitest";
import {
  IntegrationCatalogUnavailableError,
  searchIntegrationCatalog,
} from "./integration-catalog.js";

describe("searchIntegrationCatalog", () => {
  it("normalizes an integrations.sh-compatible feed and keeps unsupported surfaces visible", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      expect(url.href).toBe("https://mirror.example/catalog/api/search?q=github.com&limit=8");
      expect(init?.redirect).toBe("manual");
      return Response.json({
        results: [
          {
            domain: "github.com",
            name: "GitHub",
            description: "Developer platform",
            url: "https://mirror.example/github.com/",
            surfaces: [
              {
                kind: "mcp",
                slug: "github-mcp",
                url: "https://api.githubcopilot.com/mcp/",
                auth: {
                  kind: "mixed",
                  header: "Authorization: Bearer {pat}",
                  note: "OAuth or PAT",
                },
              },
              {
                kind: "openapi",
                slug: "github-rest",
                url: "https://example.test/openapi.json",
                auth: { kind: "token", header: "x-api-key: {token}" },
              },
              { kind: "graphql", slug: "github-graphql", url: "javascript:alert(1)" },
              { kind: "cli", slug: "github-cli" },
            ],
          },
        ],
      });
    });

    await expect(
      searchIntegrationCatalog({
        baseUrl: "https://mirror.example/catalog",
        query: "github.com",
        signal: new AbortController().signal,
        fetch,
      }),
    ).resolves.toEqual([
      {
        domain: "github.com",
        name: "GitHub",
        description: "Developer platform",
        pageUrl: "https://mirror.example/github.com/",
        surfaces: [
          {
            kind: "mcp",
            slug: "github-mcp",
            source: "https://api.githubcopilot.com/mcp/",
            auth: { type: "bearer", headerName: null, note: "OAuth or PAT" },
          },
          {
            kind: "openapi",
            slug: "github-rest",
            source: "https://example.test/openapi.json",
            auth: { type: "header", headerName: "x-api-key", note: null },
          },
          {
            kind: "graphql",
            slug: "github-graphql",
            source: null,
            auth: null,
          },
          { kind: "cli", slug: "github-cli", source: null, auth: null },
        ],
      },
    ]);
  });

  it("does not contact the feed for an empty query", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(
      searchIntegrationCatalog({
        baseUrl: "not a URL",
        query: "  ",
        signal: new AbortController().signal,
        fetch,
      }),
    ).resolves.toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects non-HTTP feeds and malformed payloads", async () => {
    await expect(
      searchIntegrationCatalog({
        baseUrl: "file:///tmp/catalog",
        query: "github.com",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("must use HTTP or HTTPS");

    await expect(
      searchIntegrationCatalog({
        baseUrl: "https://mirror.example/",
        query: "github.com",
        signal: new AbortController().signal,
        fetch: async () => Response.json({ nope: true }),
      }),
    ).rejects.toThrow("invalid response");
  });

  it("answers a response cut off mid-body as the catalog being unavailable", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"results":['));
        controller.error(new TypeError("terminated"));
      },
    });
    await expect(
      searchIntegrationCatalog({
        baseUrl: "https://mirror.example/catalog",
        query: "github.com",
        signal: new AbortController().signal,
        fetch: async () => new Response(body),
      }),
    ).rejects.toBeInstanceOf(IntegrationCatalogUnavailableError);
  });

  it("rejects oversized responses before reading them", async () => {
    await expect(
      searchIntegrationCatalog({
        baseUrl: "https://mirror.example/",
        query: "github.com",
        signal: new AbortController().signal,
        fetch: async () =>
          new Response("", { headers: { "content-length": String(RESPONSE_SIZE_OVER_LIMIT) } }),
      }),
    ).rejects.toThrow("too large");
  });

  it("rejects redirect responses instead of following them and releases their body", async () => {
    let cancels = 0;
    const body = new ReadableStream({
      cancel() {
        cancels += 1;
      },
    });
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      expect(init?.redirect).toBe("manual");
      return new Response(body, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data" },
      });
    });

    await expect(
      searchIntegrationCatalog({
        baseUrl: "https://mirror.example/catalog",
        query: "github.com",
        signal: new AbortController().signal,
        fetch,
      }),
    ).rejects.toThrow("redirects are not allowed");
    expect(fetch).toHaveBeenCalledOnce();
    expect(cancels).toBe(1);
  });

  it("allows an admin-configured private catalog base", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      expect(url.href).toBe("http://10.0.0.5:8080/catalog/api/search?q=github.com&limit=8");
      expect(init?.redirect).toBe("manual");
      return Response.json({
        results: [
          {
            domain: "github.com",
            name: "GitHub",
            description: "LAN mirror",
            url: "http://10.0.0.5:8080/github.com/",
            surfaces: [],
          },
        ],
      });
    });

    await expect(
      searchIntegrationCatalog({
        baseUrl: "http://10.0.0.5:8080/catalog",
        query: "github.com",
        signal: new AbortController().signal,
        fetch,
      }),
    ).resolves.toEqual([
      {
        domain: "github.com",
        name: "GitHub",
        description: "LAN mirror",
        pageUrl: "http://10.0.0.5:8080/github.com/",
        surfaces: [],
      },
    ]);
  });

  it.each([
    ["cannot be reached", async () => Promise.reject(new TypeError("fetch failed"))],
    ["fails", async () => new Response("down", { status: 502 })],
    ["answers with something other than JSON", async () => new Response("<html>")],
  ])(
    "answers a catalog that %s as unavailable, not as the person's mistake",
    async (_case, answer) => {
      await expect(
        searchIntegrationCatalog({
          baseUrl: "https://mirror.example/catalog",
          query: "github.com",
          signal: new AbortController().signal,
          fetch: vi.fn<typeof globalThis.fetch>(answer),
        }),
      ).rejects.toMatchObject({ kind: "SERVICE_UNAVAILABLE" });
      await expect(
        searchIntegrationCatalog({
          baseUrl: "https://mirror.example/catalog",
          query: "github.com",
          signal: new AbortController().signal,
          fetch: vi.fn<typeof globalThis.fetch>(answer),
        }),
      ).rejects.toBeInstanceOf(IntegrationCatalogUnavailableError);
    },
  );
});

const RESPONSE_SIZE_OVER_LIMIT = 1_000_001;
