import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchGithubStars,
  formatStarCount,
  GITHUB_STARS_TIMEOUT_MS,
} from "./github.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("GitHub stars", () => {
  it("returns a numeric count and formats compact labels", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ stargazers_count: 12_345 }));

    await expect(fetchGithubStars(fetchImpl as unknown as typeof fetch)).resolves.toBe(12_345);
    expect(formatStarCount(999)).toBe("999");
    expect(formatStarCount(1_250)).toBe("1.3k");
    expect(formatStarCount(12_345)).toBe("12k");
  });

  it("returns the fallback when GitHub does not settle before the deadline", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      new Promise<Response>(() => undefined),
    );

    const pending = fetchGithubStars(fetchImpl as typeof fetch);
    await vi.advanceTimersByTimeAsync(GITHUB_STARS_TIMEOUT_MS);

    await expect(pending).resolves.toBeNull();
    expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
});
