import type {
  AdapterContext,
  WebFetchRequest,
  WebFetchResult,
  WebProvider,
  WebSearchHit,
  WebSearchRequest,
} from "@rakazo/adapter-kit";
import { z } from "zod";
import { combineSignals } from "./connector-safety.js";
import { extractReadableText } from "./keyless-http-web.js";
import { clampMaxChars, clampMaxResults, clampOffset, pageWindow } from "./web-limits.js";
import type { ResolveHostname } from "./web-ssrf.js";
import { assertSafeWebUrl, fetchSafeWebText } from "./web-ssrf.js";

const SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const USER_AGENT = "Rakazo/0.1 (+https://github.com/elie222/rakazo; web tools)";
const MAX_SNIPPET_CHARS = 8_000;

const searchResponseSchema = z.object({
  web: z
    .object({
      results: z.array(
        z.object({
          url: z.string().max(8_192),
          title: z.string().nullable().optional(),
          description: z.string().nullable().optional(),
        }),
      ),
    })
    .nullable()
    .optional(),
});

export type BraveWebOptions = {
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
  resolveHostname?: ResolveHostname;
  searchTimeoutMs?: number;
  fetchTimeoutMs?: number;
  maxBufferBytes?: number;
};

/**
 * Brave Search API, for the web tools. The key comes from the
 * BRAVE_API_KEY environment variable unless one is passed in. Brave has no
 * extract endpoint, so page fetch reads the URL directly with readability
 * extraction, the same way the keyless provider does.
 */
export class BraveWebProvider implements WebProvider {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly resolveHostname?: ResolveHostname;
  private readonly searchTimeoutMs: number;
  private readonly fetchTimeoutMs: number;
  private readonly maxBufferBytes: number;

  constructor(options: BraveWebOptions = {}) {
    this.apiKey = (options.apiKey ?? process.env.BRAVE_API_KEY ?? "").trim();
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.resolveHostname = options.resolveHostname;
    this.searchTimeoutMs = options.searchTimeoutMs ?? 15_000;
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? 15_000;
    this.maxBufferBytes = options.maxBufferBytes ?? 5 * 1024 * 1024;
  }

  describe() {
    return {
      id: "brave",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        search: true,
        fetch: true,
        keyless: false,
        native: false,
        readability: true,
      },
    };
  }

  async search(request: WebSearchRequest, context: AdapterContext): Promise<WebSearchHit[]> {
    const query = request.query.trim();
    if (!query) throw new Error("query is required");
    if (!this.apiKey) throw new Error("Brave API key is not configured");
    const maxResults = clampMaxResults(request.maxResults);
    const signal = combineSignals(
      request.signal,
      context.signal,
      AbortSignal.timeout(this.searchTimeoutMs),
    );
    const searchUrl = new URL(SEARCH_ENDPOINT);
    searchUrl.searchParams.set("q", query);
    searchUrl.searchParams.set("count", String(maxResults));
    const response = await this.fetchImpl(searchUrl.href, {
      headers: {
        accept: "application/json",
        "x-subscription-token": this.apiKey,
        "user-agent": USER_AGENT,
      },
      signal,
    });
    if (!response.ok) throw new Error(`Brave search failed: HTTP ${response.status}`);
    const parsed = searchResponseSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error("Brave search returned an unexpected response");
    return (parsed.data.web?.results ?? [])
      .filter((hit) => {
        try {
          const url = new URL(hit.url);
          return url.protocol === "http:" || url.protocol === "https:";
        } catch {
          return false;
        }
      })
      .slice(0, maxResults)
      .map((hit) => ({
        url: hit.url,
        title: hit.title?.trim() || hit.url,
        snippet: (hit.description ?? "").slice(0, MAX_SNIPPET_CHARS),
      }));
  }

  async fetch(request: WebFetchRequest, context: AdapterContext): Promise<WebFetchResult> {
    const maxChars = clampMaxChars(request.maxChars);
    const offset = clampOffset(request.offset);
    const url = await assertSafeWebUrl(request.url, this.resolveHostname);
    const { body, contentType } = await fetchSafeWebText(url.href, {
      fetch: this.fetchImpl,
      resolveHostname: this.resolveHostname,
      timeoutMs: this.fetchTimeoutMs,
      maxBytes: this.maxBufferBytes,
      userAgent: USER_AGENT,
      signal: combineSignals(
        request.signal,
        context.signal,
        AbortSignal.timeout(this.fetchTimeoutMs),
      ),
    });
    if (!body.trim()) throw new Error(`Failed to fetch content from ${url}`);
    const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
    const extracted =
      mediaType === "text/plain" || mediaType === "text/markdown"
        ? { title: "Untitled", text: body }
        : extractReadableText(body, url.href);
    return {
      url: url.href,
      title: extracted.title,
      ...pageWindow(extracted.text.slice(offset), maxChars, offset),
    };
  }
}
