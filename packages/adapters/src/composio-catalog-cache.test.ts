import { describe, expect, it } from "vitest";
import {
  createToolkitDirectoryCache,
  mergeCatalogWithConnected,
} from "./composio-catalog-cache.js";

describe("composio toolkit directory cache", () => {
  it("loads once within the TTL and coalesces inflight reads", async () => {
    let loads = 0;
    const cache = createToolkitDirectoryCache({ ttlMs: 60_000, now: () => 1_000 });
    const loader = async () => {
      loads += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return [{ slug: "github", name: "GitHub", logo: null, noAuth: false }];
    };
    const [a, b] = await Promise.all([cache.get(loader), cache.get(loader)]);
    expect(loads).toBe(1);
    expect(a).toHaveLength(1);
    expect(b[0]?.slug).toBe("github");
    await cache.get(loader);
    expect(loads).toBe(1);
  });

  it("returns stale items while a TTL refresh runs", async () => {
    let now = 0;
    let loads = 0;
    const cache = createToolkitDirectoryCache({ ttlMs: 10, now: () => now });
    const first = await cache.get(async () => {
      loads += 1;
      return [{ slug: "gmail", name: "Gmail", logo: null, noAuth: false }];
    });
    expect(first[0]?.slug).toBe("gmail");
    now = 50;
    let resolveRefresh: (items: typeof first) => void = () => undefined;
    const refresh = new Promise<typeof first>((resolve) => {
      resolveRefresh = resolve;
    });
    const stale = await cache.get(() => {
      loads += 1;
      return refresh;
    });
    expect(stale[0]?.slug).toBe("gmail");
    expect(loads).toBe(2);
    resolveRefresh([{ slug: "slack", name: "Slack", logo: null, noAuth: false }]);
    await refresh;
    await new Promise((resolve) => setTimeout(resolve, 0));
    const next = await cache.get(async () => {
      loads += 1;
      return [{ slug: "linear", name: "Linear", logo: null, noAuth: false }];
    });
    expect(next[0]?.slug).toBe("slack");
    expect(loads).toBe(2);
  });

  it("marks only connected slugs on the cached directory", () => {
    const items = mergeCatalogWithConnected(
      [
        { slug: "github", name: "GitHub", logo: null, noAuth: false },
        { slug: "hackernews", name: "Hacker News", logo: null, noAuth: true },
      ],
      ["HACKERNEWS"],
    );
    expect(items.find((item) => item.slug === "github")?.connected).toBe(false);
    expect(items.find((item) => item.slug === "hackernews")?.connected).toBe(true);
  });
});
