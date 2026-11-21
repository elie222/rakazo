import { describe, expect, it } from "vitest";
import { rankModelSuggestions } from "./model-suggestions.js";

const NOW = Date.parse("2026-11-21T12:00:00.000Z");
const hoursAgo = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();

const candidate = (overrides = {}) => ({
  provider: "deepseek",
  modelId: "deepseek-v4-pro",
  label: "DeepSeek V4 Pro",
  ...overrides,
});

const usage = (overrides = {}) => ({
  provider: "deepseek",
  modelId: "deepseek-v4-pro",
  runs: 40,
  successes: 38,
  failures: 2,
  lastUsedAt: hoursAgo(1),
  lastFailedAt: hoursAgo(20),
  ...overrides,
});

describe("rankModelSuggestions", () => {
  it("puts a recently used model above an unused one", () => {
    const [top] = rankModelSuggestions(
      [
        candidate({ provider: "openai", modelId: "gpt-6", label: "GPT-6", recommended: true }),
        candidate(),
      ],
      [usage()],
      { now: NOW, limit: 2 },
    );
    expect(top?.modelId).toBe("deepseek-v4-pro");
    expect(top?.reason).toBe("recent");
    expect(top?.recentRuns).toBe(40);
  });

  it("labels use outside the window as available, not recent", () => {
    const [top] = rankModelSuggestions([candidate()], [usage({ lastUsedAt: hoursAgo(24 * 30) })], {
      now: NOW,
      windowDays: 14,
    });
    expect(top?.reason).toBe("available");
    expect(top?.lastUsedAt).toBeNull();
  });

  it("drops a model whose recent attempts all failed", () => {
    const ranked = rankModelSuggestions(
      [candidate()],
      [usage({ runs: 2, successes: 0, failures: 2, lastFailedAt: hoursAgo(0.5) })],
      { now: NOW },
    );
    expect(ranked).toEqual([]);
  });

  it("keeps a model that failed recently but still succeeds", () => {
    const ranked = rankModelSuggestions(
      [candidate()],
      [usage({ runs: 5, successes: 4, failures: 1, lastFailedAt: hoursAgo(5) })],
      { now: NOW },
    );
    expect(ranked).toHaveLength(1);
  });

  it("keeps a model whose failures are older than the failure window", () => {
    const ranked = rankModelSuggestions(
      [candidate()],
      [usage({ runs: 2, successes: 0, failures: 2, lastFailedAt: hoursAgo(6) })],
      { now: NOW, failureWindowMinutes: 60 },
    );
    expect(ranked).toHaveLength(1);
  });

  it("caps the list and never repeats a model", () => {
    const ranked = rankModelSuggestions(
      [candidate(), candidate(), candidate({ provider: "a", modelId: "a", label: "A" })],
      [],
      { now: NOW, limit: 1 },
    );
    expect(ranked).toHaveLength(1);
  });

  it("respects excluded providers", () => {
    const ranked = rankModelSuggestions([candidate()], [], {
      now: NOW,
      excludeProviders: ["DeepSeek"],
    });
    expect(ranked).toEqual([]);
  });
});
