import { describe, expect, it, vi } from "vitest";
import { FakeWeatherProvider } from "./fake-weather.js";

const published = vi.hoisted(() => [] as unknown[][]);
const publishFails = vi.hoisted(() => ({ value: false }));
vi.mock("./run-messages.js", () => ({
  publishMessage: vi.fn(async (_deps: unknown, _run: unknown, _role: string, blocks: unknown[]) => {
    if (publishFails.value) throw new Error("down");
    published.push(blocks);
  }),
}));

import { weatherTools } from "./run-tools-weather.js";

function run(args: Record<string, unknown>, weather = new FakeWeatherProvider()) {
  const ctx = { providers: { weather }, context: {}, deps: {}, run: {} };
  const call = { args, finish: async (result: unknown) => result };
  return weatherTools.weather_forecast!(ctx as never, call as never) as Promise<
    Record<string, unknown>
  >;
}

describe("weather_forecast tool", () => {
  it("posts a weather card and returns a short summary", async () => {
    published.length = 0;
    const result = await run({ location: "Lisbon", days: "5" });
    expect(published).toHaveLength(1);
    expect(published[0]?.[0]).toMatchObject({
      kind: "weather",
      forecast: { locationLabel: "Lisbon" },
    });
    expect(result).toMatchObject({ location: "Lisbon", now: { condition: "clear" } });
    expect(result.note).toMatch(/do not repeat/);
    expect(result.days).toHaveLength(5);
  });

  it("answers in words when the provider fails, with no card", async () => {
    published.length = 0;
    const weather = new FakeWeatherProvider();
    weather.error = new Error("The weather service could not be reached.");
    expect(await run({ location: "Lisbon" }, weather)).toEqual({
      error: "The weather service could not be reached.",
    });
    expect(published).toHaveLength(0);
  });

  it("still answers when the card cannot be posted", async () => {
    publishFails.value = true;
    const result = await run({ location: "Lisbon" });
    publishFails.value = false;
    expect(result.note).toMatch(/answer in words/);
  });

  it("passes coordinates through and rejects non-numbers", async () => {
    const weather = new FakeWeatherProvider();
    await run({ latitude: "38.72", longitude: -9.14 }, weather);
    expect(weather.lastRequest).toMatchObject({ latitude: 38.72, longitude: -9.14 });
    await run({ latitude: "abc", longitude: 1 }, weather);
    expect(Number.isNaN(weather.lastRequest?.latitude)).toBe(true);
  });
});
