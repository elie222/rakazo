import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchDesktopDownloads,
  fetchGithubStars,
  formatStarCount,
  GITHUB_STARS_TIMEOUT_MS,
  MAX_GITHUB_STARS_RESPONSE_BYTES,
} from "./github.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete process.env.RAKAZO_GITHUB_API;
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

  it("does not contact GitHub when tests ask for an offline star count", async () => {
    process.env.RAKAZO_GITHUB_API = "offline";
    const fetchImpl = vi.fn(async () => Response.json({ stargazers_count: 12_345 }));

    await expect(fetchGithubStars(fetchImpl as unknown as typeof fetch)).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns the fallback for an oversized GitHub response", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json(
        { stargazers_count: 12_345 },
        { headers: { "content-length": String(MAX_GITHUB_STARS_RESPONSE_BYTES + 1) } },
      ),
    );

    await expect(fetchGithubStars(fetchImpl as unknown as typeof fetch)).resolves.toBeNull();
  });
});

describe("desktop downloads", () => {
  it("picks one installer per platform from the latest release", async () => {
    const asset = (name: string) => ({
      name,
      browser_download_url: `https://github.com/elie222/rakazo/releases/download/v1.0.0/${name}`,
    });
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL) =>
      Response.json({
        assets: [
          asset("latest-mac.yml"),
          asset("Rakazo-1.0.0-universal-mac.zip"),
          asset("Rakazo-1.0.0-universal.dmg"),
          asset("Rakazo-1.0.0-universal.dmg.blockmap"),
          asset("Rakazo-1.0.0.AppImage"),
          { name: "Rakazo-1.0.0-setup.exe", browser_download_url: "http://example.com/x.exe" },
        ],
      }),
    );

    await expect(fetchDesktopDownloads(fetchImpl as unknown as typeof fetch)).resolves.toEqual({
      mac: asset("Rakazo-1.0.0-universal.dmg").browser_download_url,
      linux: asset("Rakazo-1.0.0.AppImage").browser_download_url,
    });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toMatch(/\/releases\/latest$/);
  });

  it("returns no downloads when GitHub fails", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 }));

    await expect(fetchDesktopDownloads(fetchImpl as unknown as typeof fetch)).resolves.toEqual({});
  });
});
