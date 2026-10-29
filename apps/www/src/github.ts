// Relative source path: Vercel functions cannot resolve the TypeScript exports of @rakazo/core.
import { readBoundedJsonResponse } from "../../../packages/core/src/http-response.js";
import { GITHUB_API_REPO } from "./site";

export const GITHUB_STARS_TIMEOUT_MS = 5_000;
export const MAX_GITHUB_STARS_RESPONSE_BYTES = 64 * 1024;

export type DesktopDownloads = Partial<Record<"mac" | "windows" | "linux", string>>;

const DESKTOP_ASSET_SUFFIXES = { mac: ".dmg", windows: ".exe", linux: ".AppImage" } as const;
export const MAX_GITHUB_RELEASE_RESPONSE_BYTES = 256 * 1024;
export const MAX_GITHUB_COMMITS_RESPONSE_BYTES = 512 * 1024;

export type RecentChange = { title: string; pr: string | null; url: string; date: string };

// Housekeeping commits say nothing about the product.
const QUIET_COMMIT = /^(chore|test|ci|build|docs|style|refactor)(\(.*?\))?!?:|^Merge /i;

async function fetchGithubStars(fetchImpl: typeof fetch = fetch): Promise<number | null> {
  const payload = await fetchGithubJson<{ stargazers_count?: unknown }>(
    GITHUB_API_REPO,
    MAX_GITHUB_STARS_RESPONSE_BYTES,
    fetchImpl,
  );
  return typeof payload?.stargazers_count === "number" ? payload.stargazers_count : null;
}

// Last known count, shown when the build cannot reach GitHub.
const GITHUB_STARS_FALLBACK = 6_000;
let githubStars: Promise<number> | undefined;

/** One lookup per build: anonymous requests share a 60/hour limit, and every page shows the count. */
export async function githubStarsLabel(): Promise<string> {
  githubStars ??= fetchGithubStars().then((count) => count ?? GITHUB_STARS_FALLBACK);
  return formatStarCount(await githubStars);
}

/** Desktop platforms to offer: macOS always, Windows and Linux once a release ships them. */
export function availableDesktopPlatforms(downloads: DesktopDownloads) {
  return (["mac", "windows", "linux"] as const).filter(
    (platform) => platform === "mac" || Boolean(downloads[platform]),
  );
}

/** The redirect resolves the newest installer per request, so releases need no site rebuild. */
export function desktopDownloadHref(platform: keyof DesktopDownloads) {
  return `/api/download?platform=${platform}`;
}

export async function fetchDesktopDownloads(
  fetchImpl: typeof fetch = fetch,
): Promise<DesktopDownloads> {
  const payload = await fetchGithubJson<{ assets?: unknown }>(
    `${GITHUB_API_REPO}/releases/latest`,
    MAX_GITHUB_RELEASE_RESPONSE_BYTES,
    fetchImpl,
  );
  const downloads: DesktopDownloads = {};
  if (!Array.isArray(payload?.assets)) return downloads;
  for (const asset of payload.assets as Array<{ name?: unknown; browser_download_url?: unknown }>) {
    const { name, browser_download_url: url } = asset ?? {};
    if (typeof name !== "string" || typeof url !== "string" || !url.startsWith("https://")) continue;
    for (const [platform, suffix] of Object.entries(DESKTOP_ASSET_SUFFIXES)) {
      if (name.endsWith(suffix)) downloads[platform as keyof DesktopDownloads] ??= url;
    }
  }
  return downloads;
}

/** The newest product changes on main, newest first; empty when GitHub is unavailable. */
export async function fetchRecentChanges(
  limit: number,
  fetchImpl: typeof fetch = fetch,
): Promise<RecentChange[]> {
  const payload = await fetchGithubJson<unknown>(
    `${GITHUB_API_REPO}/commits?per_page=30`,
    MAX_GITHUB_COMMITS_RESPONSE_BYTES,
    fetchImpl,
  );
  if (!Array.isArray(payload)) return [];
  const changes: RecentChange[] = [];
  for (const entry of payload as Array<{
    html_url?: unknown;
    commit?: { message?: unknown; committer?: { date?: unknown } };
  }>) {
    const message = entry?.commit?.message;
    const date = entry?.commit?.committer?.date;
    const url = entry?.html_url;
    if (typeof message !== "string" || typeof date !== "string" || typeof url !== "string") continue;
    const subject = message.split("\n", 1)[0]!.trim();
    if (!subject || QUIET_COMMIT.test(subject)) continue;
    const pr = subject.match(/\s*\(#(\d+)\)$/);
    const title = subject.slice(0, pr?.index ?? subject.length).replace(/^\w+(\(.*?\))?!?:\s*/, "");
    changes.push({ title: title.charAt(0).toUpperCase() + title.slice(1), pr: pr?.[1] ?? null, url, date });
    if (changes.length === limit) break;
  }
  return changes;
}

async function fetchGithubJson<T>(
  url: string,
  maxBytes: number,
  fetchImpl: typeof fetch,
): Promise<T | null> {
  if (process.env.RAKAZO_GITHUB_API === "offline") return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITHUB_STARS_TIMEOUT_MS);
  try {
    const response = await withAbort(
      fetchImpl(url, {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "rakazo-www",
          // Optional: anonymous requests share a 60/hour limit per IP.
          ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
        },
        signal: controller.signal,
      }),
      controller.signal,
    );
    if (!response.ok) {
      cancelResponseBody(response);
      return null;
    }
    return await readBoundedJsonResponse<T>(response, maxBytes, controller.signal);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function cancelResponseBody(response: Response): void {
  try {
    void Promise.resolve(response.body?.cancel()).catch(() => undefined);
  } catch {
    // Best-effort release only; cancellation must not delay static rendering.
  }
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Request timed out"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("Request timed out"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export function formatStarCount(count: number): string {
  if (count < 1000) {
    return String(count);
  }
  const thousands = count / 1000;
  const rounded = thousands >= 10 ? Math.round(thousands) : Math.round(thousands * 10) / 10;
  return `${rounded}k`.replace(/\.0k$/, "k");
}
