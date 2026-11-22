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
  it("ranks a recently used model and omits unused catalog rows", () => {
    const ranked = rankModelSuggestions(
      [
        candidate({ provider: "openai", modelId: "gpt-6", label: "GPT-6", recommended: true }),
        candidate(),
      ],
      [usage()],
      { now: NOW, limit: 2 },
    );
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.modelId).toBe("deepseek-v4-pro");
    expect(ranked[0]?.reason).toBe("recent");
    expect(ranked[0]?.recentRuns).toBe(40);
  });

  it("omits use outside the window instead of filling Suggested with unused models", () => {
    const ranked = rankModelSuggestions([candidate()], [usage({ lastUsedAt: hoursAgo(24 * 30) })], {
      now: NOW,
      windowDays: 14,
    });
    expect(ranked).toEqual([]);
  });

  it("omits unused catalog models from Suggested", () => {
    const ranked = rankModelSuggestions(
      [candidate({ provider: "openai", modelId: "gpt-6", label: "GPT-6", recommended: true })],
      [],
      { now: NOW },
    );
    expect(ranked).toEqual([]);
  });

  it("drops a model whose recent attempts all failed", () => {
    const ranked = rankModelSuggestions(
      [candidate()],
      [usage({ runs: 2, successes: 0, failures: 2, lastFailedAt: hoursAgo(0.5) })],
      { now: NOW },
    );
    expect(ranked).toEqual([]);
  });

  it("drops a previously successful model after recent failures with no later success", () => {
    // Totals still favor success (38 > 2), but the latest outcomes failed.
    const ranked = rankModelSuggestions(
      [candidate()],
      [
        usage({
          runs: 40,
          successes: 38,
          failures: 2,
          lastUsedAt: hoursAgo(2),
          lastFailedAt: hoursAgo(0.25),
        }),
      ],
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

  it("keeps a recently used model whose failures are older than the failure window", () => {
    // Failures six hours ago are outside the one-hour exhaustion window; a
    // later success (default lastUsedAt) keeps the model suggested.
    const ranked = rankModelSuggestions(
      [candidate()],
      [usage({ runs: 4, successes: 2, failures: 2, lastFailedAt: hoursAgo(6) })],
      { now: NOW },
    );
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.reason).toBe("recent");
  });

  it("caps the list and never repeats a model", () => {
    const ranked = rankModelSuggestions(
      [
        candidate(),
        candidate(),
        candidate({ provider: "openai", modelId: "gpt-6", label: "GPT-6" }),
      ],
      [
        usage(),
        usage({
          provider: "openai",
          modelId: "gpt-6",
          runs: 10,
          successes: 10,
          failures: 0,
          lastFailedAt: null,
        }),
      ],
      { now: NOW, limit: 1 },
    );
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.modelId).toBe("deepseek-v4-pro");
  });

});
