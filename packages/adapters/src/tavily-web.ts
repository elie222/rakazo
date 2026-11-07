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
import { clampMaxChars, clampMaxResults, clampOffset, pageWindow } from "./web-limits.js";

const SEARCH_ENDPOINT = "https://api.tavily.com/search";
const EXTRACT_ENDPOINT = "https://api.tavily.com/extract";
const USER_AGENT = "Rakazo/0.1 (+https://github.com/elie222/rakazo; web tools)";
const MAX_SNIPPET_CHARS = 8_000;

const searchResponseSchema = z.object({
  results: z.array(
    z.object({
      url: z.string().max(8_192),
      title: z.string().nullable().optional(),
      content: z.string().nullable().optional(),
    }),
  ),
});

const extractResponseSchema = z.object({
  results: z.array(
    z.object({
      url: z.string().max(8_192),
      title: z.string().nullable().optional(),
      raw_content: z.string().nullable().optional(),
    }),
  ),
  failed_results: z.array(z.object({ url: z.string() })).optional(),
});

export type TavilyWebOptions = {
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
  searchTimeoutMs?: number;
  fetchTimeoutMs?: number;
};

/**
 * Tavily search + extract, for the web tools. The key comes from the
 * TAVILY_API_KEY environment variable unless one is passed in. Tavily is
 * built for agents, so its search results carry a clean snippet per hit.
 */
export class TavilyWebProvider implements WebProvider {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly searchTimeoutMs: number;
  private readonly fetchTimeoutMs: number;

  constructor(options: TavilyWebOptions = {}) {
    this.apiKey = (options.apiKey ?? process.env.TAVILY_API_KEY ?? "").trim();
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.searchTimeoutMs = options.searchTimeoutMs ?? 15_000;
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? 15_000;
  }

  describe() {
    return {
      id: "tavily",
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
    if (!this.apiKey) throw new Error("Tavily API key is not configured");
    const maxResults = clampMaxResults(request.maxResults);
    const signal = combineSignals(
      request.signal,
      context.signal,
      AbortSignal.timeout(this.searchTimeoutMs),
    );
    const response = await this.fetchImpl(SEARCH_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": USER_AGENT,
      },
      body: JSON.stringify({
        api_key: this.apiKey,
        query,
        search_depth: "basic",
        max_results: maxResults,
        include_answer: false,
        include_raw_content: false,
      }),
      signal,
    });
    if (!response.ok) throw new Error(`Tavily search failed: HTTP ${response.status}`);
    const parsed = searchResponseSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error("Tavily search returned an unexpected response");
    return parsed.data.results
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
        snippet: (hit.content ?? "").slice(0, MAX_SNIPPET_CHARS),
      }));
  }

  async fetch(request: WebFetchRequest, context: AdapterContext): Promise<WebFetchResult> {
    const url = request.url.trim();
    if (!url) throw new Error("url is required");
    if (!this.apiKey) throw new Error("Tavily API key is not configured");
    const maxChars = clampMaxChars(request.maxChars);
    const offset = clampOffset(request.offset);
    const signal = combineSignals(
      request.signal,
      context.signal,
      AbortSignal.timeout(this.fetchTimeoutMs),
    );
    const response = await this.fetchImpl(EXTRACT_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": USER_AGENT,
      },
      body: JSON.stringify({
        api_key: this.apiKey,
        urls: [url],
        extract_depth: "basic",
      }),
      signal,
    });
    if (!response.ok) throw new Error(`Tavily extract failed: HTTP ${response.status}`);
    const parsed = extractResponseSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error("Tavily extract returned an unexpected response");
    const page = parsed.data.results[0];
    const text = page?.raw_content ?? "";
    if (!page || !/\S/.test(text)) throw new Error("Tavily extract returned no content");
    return {
      url: page.url,
      title: page.title?.trim() || page.url,
      ...pageWindow(text.slice(offset), maxChars, offset),
    };
  }
}
