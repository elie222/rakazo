import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginMarketplace, parsePluginMarketplace } from "./plugin-marketplace.js";

const registry = { name: "Cursor", repository: "https://github.com/example/plugins" };
const index = (plugins: unknown[]) => JSON.stringify({ name: "example", plugins });
const sha = "a".repeat(40);
afterEach(() => vi.restoreAllMocks());

describe("public marketplace indexes", () => {
  it("maps Cursor relative directories to importable sources", () => {
    const result = parsePluginMarketplace(
      index([{ name: "notes", source: "./notes", description: "Daily notes" }]),
      registry,
    );
    expect(result.entries).toEqual([
      {
        id: "Cursor:https://github.com/example/plugins#notes",
        name: "notes",
        description: "Daily notes",
        keywords: [],
        registry: "Cursor",
        source: "https://github.com/example/plugins#notes",
        installedSource: "https://github.com/example/plugins#notes",
      },
    ]);
  });
  it("loads xAI local-directory source objects without allowing traversal", () => {
    const result = parsePluginMarketplace(
      index([
        { name: "neon", source: { type: "local", path: "./external_plugins/neon" } },
        { name: "escape", source: { type: "local", path: "./../escape" } },
      ]),
      { name: "xAI", repository: "https://github.com/example/index" },
    );
    expect(result.entries[0]?.source).toBe(
      "https://github.com/example/index#external_plugins/neon",
    );
    expect(result.skipped).toBe(1);
  });
  it("preserves xAI URL-object pins and canonical installed identity", () => {
    const result = parsePluginMarketplace(
      index([
        {
          name: "tasks",
          source: { source: "url", url: "https://github.com/Example/Tasks.git", sha },
          keywords: ["planning"],
        },
      ]),
      { name: "xAI", repository: "https://github.com/example/index" },
    );
    expect(result.entries[0]).toMatchObject({
      source: `https://github.com/example/tasks@${sha}`,
      installedSource: "https://github.com/example/tasks",
      registry: "xAI",
      keywords: ["planning"],
    });
  });
  it("loads direct GitHub sources, reports invalid entries and removes duplicates", () => {
    const result = parsePluginMarketplace(
      index([
        { name: "valid", source: "https://github.com/example/valid/tree/main/subdir" },
        { name: "duplicate", source: "https://github.com/example/valid@main#subdir" },
        { name: "traversal", source: "../escape" },
        { name: "absolute", source: "/root" },
        { name: "private", source: "https://127.0.0.1/a/b" },
        { name: "credentials", source: "https://user:password@github.com/a/b" },
        {
          name: "bad-pin",
          source: { source: "url", url: "https://github.com/example/tasks", sha: "main" },
        },
        {
          name: "conflicting",
          source: { source: "url", url: "https://github.com/example/tasks@other", sha },
        },
      ]),
      registry,
    );
    expect(result.entries).toHaveLength(1);
    expect(result.skipped).toBe(7);
  });
  it("rejects malformed or oversized index structure", () => {
    expect(() => parsePluginMarketplace("invalid", registry)).toThrow();
    expect(() => parsePluginMarketplace(JSON.stringify({ plugins: {} }), registry)).toThrow();
    expect(() => parsePluginMarketplace(index(Array(1001).fill({})), registry)).toThrow();
  });
});

describe("marketplace service", () => {
  it("filters metadata, caches success, and does not cache provider failures", async () => {
    let failed = true;
    const read = vi.fn(async (url: string) => {
      if (url.includes("xai-org")) {
        if (failed) throw new Error("Unavailable");
        return index([{ name: "Tasks", source: "tasks", keywords: ["planning"] }]);
      }
      return index([{ name: "Notes", description: "Daily planning", source: "notes" }]);
    });
    const service = createPluginMarketplace(read);
    const first = await service.catalog("PLANNING daily");
    expect(first.entries.map((entry) => entry.name)).toEqual(["Notes"]);
    expect(first.unavailableRegistries).toEqual(["xAI"]);
    failed = false;
    const second = await service.catalog("planning");
    expect(second.entries.map((entry) => entry.name)).toEqual(["Notes", "Tasks"]);
    expect(second.unavailableRegistries).toEqual([]);
    expect(read).toHaveBeenCalledTimes(3);
    await service.catalog("no match");
    expect(read).toHaveBeenCalledTimes(3);
  });
  it("shares concurrent reads and expires the per-instance cache", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    const read = vi.fn(async () => index([{ name: "Notes", source: "notes" }]));
    const service = createPluginMarketplace(read);
    await Promise.all([service.catalog(""), service.catalog("Notes")]);
    expect(read).toHaveBeenCalledTimes(2);
    now.mockReturnValue(62_000);
    await service.catalog("");
    expect(read).toHaveBeenCalledTimes(4);
  });
  it("returns explicit unavailability without leaking provider errors", async () => {
    const service = createPluginMarketplace(async () => {
      throw new Error("private diagnostic");
    });
    expect(await service.catalog("")).toEqual({
      entries: [],
      unavailableRegistries: ["Cursor", "xAI"],
      skippedEntries: 0,
    });
  });
});
