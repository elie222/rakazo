import { PAGE_RUNTIME_PATH } from "@rakazo/core";

type Runtime = { text: string; etag: string | null };

const runtimes = new Map<string, Runtime>();
const pending = new Map<string, Promise<string>>();

/**
 * The page runtime from the user's own server; the page document inlines it because the viewer's
 * policy loads nothing. Each use asks the server again with the last copy's tag, as its
 * `no-cache` asks, so a page never runs on a kit older than the server that checked it. Uses
 * that overlap share one request, and a failed request is retried next time.
 */
export function loadPageRuntime(apiBase: string, fetcher: typeof fetch = fetch): Promise<string> {
  const url = new URL(PAGE_RUNTIME_PATH, apiBase).href;
  let runtime = pending.get(url);
  if (!runtime) {
    const cached = runtimes.get(url);
    runtime = fetcher(url, cached?.etag ? { headers: { "if-none-match": cached.etag } } : {})
      .then(async (response) => {
        if (response.status === 304 && cached) return cached.text;
        if (!response.ok) throw new Error(`Page runtime returned ${response.status}`);
        const text = await response.text();
        runtimes.set(url, { text, etag: response.headers.get("etag") });
        return text;
      })
      .finally(() => pending.delete(url));
    pending.set(url, runtime);
  }
  return runtime;
}
