import { GITHUB_API_REPO } from "./site";

export const GITHUB_STARS_TIMEOUT_MS = 5_000;

export async function fetchGithubStars(fetchImpl: typeof fetch = fetch): Promise<number | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITHUB_STARS_TIMEOUT_MS);
  try {
    const response = await withAbort(
      fetchImpl(GITHUB_API_REPO, {
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
    const payload = (await withAbort(response.json(), controller.signal)) as {
      stargazers_count?: unknown;
    };
    return typeof payload.stargazers_count === "number" ? payload.stargazers_count : null;
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
