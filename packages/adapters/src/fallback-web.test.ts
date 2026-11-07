import type { AdapterContext, WebProvider } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { FakeWebProvider } from "./fake-web.js";
import { FallbackWebProvider } from "./fallback-web.js";

const ctx: AdapterContext = {
  operationId: "1",
  traceId: "1",
  spaceId: "w",
  userId: "u",
  signal: new AbortController().signal,
};

function failingProvider(id: string, message: string): WebProvider {
  return {
    describe: () => ({
      id,
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { search: true, fetch: true, keyless: true, native: false, readability: true },
    }),
    search: async () => {
      throw new Error(message);
    },
    fetch: async () => {
      throw new Error(message);
    },
  };
}

function fakeProvider(hits: { title: string; url: string; snippet: string }[]): FakeWebProvider {
  const provider = new FakeWebProvider();
  provider.searchHits = hits;
  provider.fetchResult = {
    url: "https://example.test/page",
    title: "Hit",
    text: "body",
    truncated: false,
  };
  return provider;
}

describe("fallback web provider", () => {
  it("needs at least one provider", () => {
    expect(() => new FallbackWebProvider([])).toThrow("at least one provider");
  });

  it("returns the first provider that answers a search", async () => {
    const first = failingProvider("first", "first is down");
    const second = fakeProvider([{ title: "Hit", url: "https://example.test/page", snippet: "…" }]);
    const provider = new FallbackWebProvider([first, second]);
    expect(provider.describe().id).toBe("fallback");
    await expect(provider.search({ query: "q", maxResults: 3 }, ctx)).resolves.toEqual([
      { title: "Hit", url: "https://example.test/page", snippet: "…" },
    ]);
  });

  it("skips a provider that returns no results and tries the next", async () => {
    const empty = fakeProvider([]);
    const second = fakeProvider([{ title: "Hit", url: "https://example.test/page", snippet: "…" }]);
    const provider = new FallbackWebProvider([empty, second]);
    await expect(provider.search({ query: "q", maxResults: 3 }, ctx)).resolves.toEqual([
      { title: "Hit", url: "https://example.test/page", snippet: "…" },
    ]);
  });

  it("reports every provider when none answers a search", async () => {
    const provider = new FallbackWebProvider([
      failingProvider("first", "first is down"),
      failingProvider("second", "second is down"),
    ]);
    await expect(provider.search({ query: "q", maxResults: 3 }, ctx)).rejects.toThrow(
      "first: first is down; second: second is down",
    );
  });

  it("falls back for fetch when the first provider fails", async () => {
    const first = failingProvider("first", "first is down");
    const second = fakeProvider([]);
    const provider = new FallbackWebProvider([first, second]);
    await expect(
      provider.fetch({ url: "https://example.test/page", maxChars: 500 }, ctx),
    ).resolves.toEqual({
      url: "https://example.test/page",
      title: "Hit",
      text: "body",
      truncated: false,
    });
  });

  it("reports every provider when none answers a fetch", async () => {
    const provider = new FallbackWebProvider([
      failingProvider("first", "first is down"),
      failingProvider("second", "second is down"),
    ]);
    await expect(
      provider.fetch({ url: "https://example.test/page", maxChars: 500 }, ctx),
    ).rejects.toThrow("first: first is down; second: second is down");
  });
});
