// Relative source path: Vercel functions cannot resolve the TypeScript exports of @rakazo/core.
import { readBoundedJsonResponse } from "../../../packages/core/src/http-response.js";
import { GITHUB_API_REPO } from "./site";

export const GITHUB_STARS_TIMEOUT_MS = 5_000;
export const MAX_GITHUB_STARS_RESPONSE_BYTES = 64 * 1024;

export type DesktopDownloads = Partial<Record<"mac" | "windows" | "linux", string>>;

const DESKTOP_ASSET_SUFFIXES = { mac: ".dmg", windows: ".exe", linux: ".AppImage" } as const;
export const MAX_GITHUB_RELEASE_RESPONSE_BYTES = 256 * 1024;

export async function fetchGithubStars(fetchImpl: typeof fetch = fetch): Promise<number | null> {
  const payload = await fetchGithubJson<{ stargazers_count?: unknown }>(
    GITHUB_API_REPO,
    MAX_GITHUB_STARS_RESPONSE_BYTES,
    fetchImpl,
  );
  return typeof payload?.stargazers_count === "number" ? payload.stargazers_count : null;
}

/** Installer URLs from the latest desktop release; empty when GitHub is unavailable. */
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
