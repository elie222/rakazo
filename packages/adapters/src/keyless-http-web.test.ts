import type { AdapterContext } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { FakeWebProvider } from "./fake-web.js";
import {
  extractReadableText,
  KeylessHttpWebProvider,
  parseDuckDuckGoResults,
} from "./keyless-http-web.js";
import {
  clampMaxChars,
  clampMaxResults,
  clampOffset,
  MAX_WEB_FETCH_OFFSET,
  pageWindow,
} from "./web-limits.js";
import { createWebProvider, resolveWebProviderKind } from "./web-provider-factory.js";
import { webFetchFromTool, webSearchFromTool } from "./web-tools.js";

const ctx: AdapterContext = {
  operationId: "1",
  traceId: "1",
  spaceId: "w",
  userId: "u",
  signal: new AbortController().signal,
};

const publicResolver = async () => [{ address: "203.0.113.10", family: 4 as const }];

describe("web provider factory", () => {
  it("defaults to keyless-http", () => {
    expect(resolveWebProviderKind({})).toBe("keyless-http");
    expect(createWebProvider().describe().id).toBe("keyless-http");
    expect(createWebProvider("fake").describe().id).toBe("fake");
  });
});

describe("keyless HTTP web provider", () => {
  it.each(["Text/Plain; charset=utf-8", "text/markdown"])(
    "preserves literal %s content through the fetch tool",
    async (contentType) => {
      const body = "Use <project-root>/src &amp; keep  spacing\n  indented\n";
      const provider = new KeylessHttpWebProvider({
        fetch: async () => new Response(body, { headers: { "content-type": contentType } }),
        resolveHostname: publicResolver,
      });

      await expect(
        webFetchFromTool(provider, ctx, { url: "https://example.test/doc" }),
      ).resolves.toEqual({
        url: "https://example.test/doc",
        title: "Untitled",
        text: body,
        truncated: false,
      });
    },
  );

  it("uses the final response's MIME type after a redirect", async () => {
    const provider = new KeylessHttpWebProvider({
      fetch: async (input) =>
        String(input).endsWith("/start")
          ? new Response(null, {
              status: 302,
              headers: { location: "/final", "content-type": "text/html" },
            })
          : new Response("Use <project-root>/src", {
              headers: { "content-type": "text/plain; charset=UTF-8" },
            }),
      resolveHostname: publicResolver,
    });
    await expect(
      webFetchFromTool(provider, ctx, { url: "https://example.test/start" }),
    ).resolves.toMatchObject({
      url: "https://example.test/final",
      text: "Use <project-root>/src",
    });
  });

  it("paginates preserved plain text", async () => {
    const body = "<x>  ".repeat(50);
    const provider = new KeylessHttpWebProvider({
      fetch: async () => new Response(body, { headers: { "content-type": "text/plain" } }),
      resolveHostname: publicResolver,
    });
    await expect(
      webFetchFromTool(provider, ctx, { url: "https://example.test/doc", maxChars: 100 }),
    ).resolves.toMatchObject({
      text: `${body.slice(0, 100)}\n\n[Content truncated; continue with offset 100]`,
      truncated: true,
    });
    await expect(
      webFetchFromTool(provider, ctx, {
        url: "https://example.test/doc",
        maxChars: 100,
        offset: 200,
      }),
    ).resolves.toMatchObject({ text: body.slice(200), truncated: false });
  });

  it("keeps the byte limit for plain text", async () => {
    const provider = new KeylessHttpWebProvider({
      fetch: async () =>
        new Response("<x>".repeat(40), { headers: { "content-type": "text/plain" } }),
      resolveHostname: publicResolver,
      maxBufferBytes: 100,
    });
    await expect(
      webFetchFromTool(provider, ctx, { url: "https://example.test/doc" }),
    ).resolves.toEqual({
      error: "Response is too large",
    });
  });

  it("cancels an ongoing plain text read", async () => {
    const controller = new AbortController();
    let bodyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      bodyStarted = resolve;
    });
    const provider = new KeylessHttpWebProvider({
      fetch: async () =>
        new Response(
          new ReadableStream({
            start() {
              bodyStarted();
            },
          }),
          {
            headers: { "content-type": "text/plain" },
          },
        ),
      resolveHostname: publicResolver,
    });
    const pending = webFetchFromTool(
      provider,
      { ...ctx, signal: controller.signal },
      { url: "https://example.test/doc" },
    );
    await started;
    controller.abort(new Error("cancelled"));
    await expect(pending).resolves.toEqual({ error: "cancelled" });
  });

  it("still extracts HTML and does not treat similar media types as plain text", async () => {
    for (const contentType of ["text/html; charset=utf-8", "text/plain-extra"]) {
      const provider = new KeylessHttpWebProvider({
        fetch: async () =>
          new Response("<title>Doc</title><p>hello <b>world</b></p>", {
            headers: { "content-type": contentType },
          }),
        resolveHostname: publicResolver,
      });
      const result = await webFetchFromTool(provider, ctx, { url: "https://example.test/doc" });
      expect(result).toMatchObject({ title: "Doc", text: "hello world", truncated: false });
    }
  });

  it("searches via the HTML backend without a vendor API key", async () => {
    const html = `
      <div class="result">
        <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.test%2Fa">Alpha</a>
        <a class="result__snippet">Snippet A</a>
      </div>
      <div class="result">
        <a class="result__a" href="https://example.test/b">Beta</a>
        <div class="result__snippet">Snippet B</div>
      </div>
    `;
    const fetchMock: typeof fetch = async () =>
      new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    const provider = new KeylessHttpWebProvider({
      fetch: fetchMock,
      resolveHostname: publicResolver,
    });
    const results = await provider.search({ query: "alpha", maxResults: 5 }, ctx);
    expect(results).toEqual([
      { title: "Alpha", url: "https://example.test/a", snippet: "Snippet A" },
      { title: "Beta", url: "https://example.test/b", snippet: "Snippet B" },
    ]);
  });

  it("fetches readable page text with truncation", async () => {
    const long = Array.from({ length: 100 }, (_, i) => `w${i}`).join(" ");
    const html = `<html><head><title>Doc</title></head><body><article><p>${long}</p></article></body></html>`;
    const fetchMock: typeof fetch = async () =>
      new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    const provider = new KeylessHttpWebProvider({
      fetch: fetchMock,
      resolveHostname: publicResolver,
    });
    const result = await provider.fetch({ url: "https://example.test/doc", maxChars: 120 }, ctx);
    expect(result.title).toBeTruthy();
    expect(result.url).toBe("https://example.test/doc");
    expect(result.truncated).toBe(true);
    expect(result.text).toBe(
      `${long.slice(0, 120)}\n\n[Content truncated; continue with offset 120]`,
    );

    const next = await provider.fetch(
      { url: "https://example.test/doc", maxChars: 120, offset: 120 },
      ctx,
    );
    expect(next.text).toBe(
      `${long.slice(120, 240)}\n\n[Content truncated; continue with offset 240]`,
    );

    const last = await provider.fetch(
      { url: "https://example.test/doc", maxChars: 120, offset: 360 },
      ctx,
    );
    expect(last).toMatchObject({ text: long.slice(360), truncated: false });
  });

  it("falls back to HTML strip when Readability finds nothing", () => {
    const extracted = extractReadableText(
      "<html><title>Plain</title><body><div>just text here</div></body></html>",
      "https://example.test/",
    );
    expect(extracted.title).toBe("Plain");
    expect(extracted.text).toContain("just text here");
  });

  it("parses HTML search results with a cap", () => {
    const html = Array.from({ length: 12 }, (_, i) => {
      return `<div class="result"><a class="result__a" href="https://example.test/${i}">T${i}</a><div class="result__snippet">S${i}</div></div>`;
    }).join("");
    expect(parseDuckDuckGoResults(html, 3)).toHaveLength(3);
  });
});

describe("web tool apply with fake provider", () => {
  it("returns injected search and fetch results", async () => {
    const fake = new FakeWebProvider();
    fake.searchHits = [
      { title: "One", url: "https://example.test/1", snippet: "s1" },
      { title: "Two", url: "https://example.test/2", snippet: "s2" },
    ];
    fake.fetchResult = {
      url: "https://example.test/1",
      title: "One",
      text: "Body text",
      truncated: false,
    };

    await expect(webSearchFromTool(fake, ctx, { query: "q", maxResults: 1 })).resolves.toEqual({
      results: [{ title: "One", url: "https://example.test/1", snippet: "s1" }],
    });
    expect(fake.lastSearch?.query).toBe("q");

    await expect(
      webFetchFromTool(fake, ctx, { url: "https://example.test/1", maxChars: 100 }),
    ).resolves.toEqual({
      url: "https://example.test/1",
      title: "One",
      text: "Body text",
      truncated: false,
    });
  });

  it("surfaces provider errors as tool errors", async () => {
    const fake = new FakeWebProvider();
    fake.searchError = new Error("boom");
    await expect(webSearchFromTool(fake, ctx, { query: "q" })).resolves.toEqual({
      error: "boom",
    });
  });
});

describe("web tool clamps", () => {
  it("clamps maxResults and maxChars", () => {
    expect(clampMaxResults(undefined)).toBe(5);
    expect(clampMaxResults(100)).toBe(10);
    expect(clampMaxResults(0)).toBe(1);
    expect(clampMaxChars(undefined)).toBe(8_000);
    expect(clampMaxChars(10)).toBe(100);
    expect(clampMaxChars(999_999)).toBe(50_000);
  });

  it("bounds offset and names the next read in a cut", () => {
    expect(clampOffset(undefined)).toBe(0);
    expect(clampOffset(-4)).toBe(0);
    expect(clampOffset(1.9)).toBe(1);
    expect(clampOffset(MAX_WEB_FETCH_OFFSET)).toBe(MAX_WEB_FETCH_OFFSET);
    expect(() => clampOffset(MAX_WEB_FETCH_OFFSET + 1)).toThrow(
      `web_fetch can skip at most ${MAX_WEB_FETCH_OFFSET} characters.`,
    );
    expect(pageWindow("cdefgh", 4, 2)).toEqual({
      text: "cdef\n\n[Content truncated; continue with offset 6]",
      truncated: true,
    });
    expect(pageWindow("ab", 4, 0)).toEqual({ text: "ab", truncated: false });
    expect(pageWindow("abcdef", 4, MAX_WEB_FETCH_OFFSET - 1)).toEqual({
      text: "abcd\n\n[Content truncated; stopped at the read limit]",
      truncated: true,
    });
  });

  it("reads the next fake window and ignores a negative offset", async () => {
    const fake = new FakeWebProvider();
    fake.fetchResult = { ...fake.fetchResult, text: "abcdefghij" };
    await expect(
      fake.fetch({ url: "https://example.test/1", maxChars: 4, offset: 2 }, ctx),
    ).resolves.toMatchObject({
      text: "cdef\n\n[Content truncated; continue with offset 6]",
      truncated: true,
    });
    await expect(
      fake.fetch({ url: "https://example.test/1", maxChars: 4, offset: -3 }, ctx),
    ).resolves.toMatchObject({
      text: "abcd\n\n[Content truncated; continue with offset 4]",
      truncated: true,
    });
    expect(fake.lastFetch?.offset).toBe(-3);

    const rejected = new FakeWebProvider();
    await expect(
      webFetchFromTool(rejected, ctx, {
        url: "https://example.test/1",
        offset: MAX_WEB_FETCH_OFFSET + 1,
      }),
    ).resolves.toEqual({
      error: `web_fetch can skip at most ${MAX_WEB_FETCH_OFFSET} characters.`,
    });
    expect(rejected.lastFetch).toBeUndefined();
  });
});
