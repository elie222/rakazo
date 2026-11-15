import { describe, expect, it, vi } from "vitest";
import { FakePlacesProvider } from "./fake-places.js";

const published = vi.hoisted(() => [] as unknown[][]);
const publishFails = vi.hoisted(() => ({ value: false }));
vi.mock("./run-messages.js", () => ({
  publishMessage: vi.fn(async (_deps: unknown, _run: unknown, _role: string, blocks: unknown[]) => {
    if (publishFails.value) throw new Error("down");
    published.push(blocks);
  }),
}));

import { placesTools } from "./run-tools-places.js";

function run(args: Record<string, unknown>, places = new FakePlacesProvider()) {
  const ctx = { providers: { places }, context: {}, deps: {}, run: {} };
  const call = { args, finish: async (result: unknown) => result };
  return placesTools.places_search!(ctx as never, call as never) as Promise<
    Record<string, unknown>
  >;
}

describe("places_search tool", () => {
  it("posts a places card and returns a short summary", async () => {
    published.length = 0;
    const result = await run({ query: "pharmacy", near: "Lisbon", limit: "3" });
    expect(published).toHaveLength(1);
    expect(published[0]?.[0]).toMatchObject({ kind: "places", card: { query: "pharmacy" } });
    expect(result).toMatchObject({ query: "pharmacy", count: 3 });
    expect(result.note).toMatch(/do not repeat/);
    expect(result.places).toHaveLength(3);
  });

  it("answers in words when the provider fails, with no card", async () => {
    published.length = 0;
    const places = new FakePlacesProvider();
    places.error = new Error("The places service could not be reached.");
    expect(await run({ query: "pharmacy" }, places)).toEqual({
      error: "The places service could not be reached.",
    });
    expect(published).toHaveLength(0);
  });

  it("still answers when the card cannot be posted", async () => {
    publishFails.value = true;
    const result = await run({ query: "pharmacy" });
    publishFails.value = false;
    expect(result.note).toMatch(/answer in words/);
  });

  it("passes coordinates through and rejects non-numbers", async () => {
    const places = new FakePlacesProvider();
    await run({ query: "cafe", latitude: "38.72", longitude: -9.14 }, places);
    expect(places.lastRequest).toMatchObject({ latitude: 38.72, longitude: -9.14 });
    await run({ query: "cafe", latitude: "abc", longitude: 1 }, places);
    expect(Number.isNaN(places.lastRequest?.latitude)).toBe(true);
  });
});
