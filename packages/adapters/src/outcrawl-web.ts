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
import type { ResolveHostname } from "./web-ssrf.js";
import { assertSafeWebUrl, readBodyCapped, withAbort } from "./web-ssrf.js";

const ENDPOINT = "https://api.outcrawl.ai/v1";
const USER_AGENT = "Rakazo/0.1 (+https://github.com/elie222/rakazo; web tools)";
const MAX_SNIPPET_CHARS = 8_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const searchSchema = z.object({
  hits: z.array(
    z.object({
      url: z.string().max(8_192),
      title: z.string().nullable().optional(),
      snippet: z.string().nullable().optional(),
    }),
  ),
});
const pageSchema = z.object({
  url: z.string().max(8_192).optional(),
  statusCode: z.number().optional(),
  markdown: z.string().nullable().optional(),
  metadata: z.object({ title: z.string().nullable().optional() }).passthrough().optional(),
});

export type OutcrawlWebOptions = {
  fetch?: typeof globalThis.fetch;
  resolveHostname?: ResolveHostname;
  searchTimeoutMs?: number;
  fetchTimeoutMs?: number;
};

/** Optional HTTPS backend for the existing builtin web tools; needs OUTCRAWL_API_KEY. */
export class OutcrawlWebProvider implements WebProvider {
  private readonly apiKey = process.env.OUTCRAWL_API_KEY?.trim();

  constructor(private readonly options: OutcrawlWebOptions = {}) {}

  describe() {
    return {
      id: "outcrawl",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { search: true, fetch: true, keyless: false, native: false, readability: true },
    };
  }

  async search(request: WebSearchRequest, context: AdapterContext): Promise<WebSearchHit[]> {
    const query = request.query.trim();
    if (!query) throw new Error("query is required");
    const maxResults = clampMaxResults(request.maxResults);
    const signal = this.signal(
      combineSignals(request.signal, context.signal),
      this.options.searchTimeoutMs,
    );
    const response = await this.call("search", { query, limit: maxResults }, signal, searchSchema);
    return response.hits
      .filter((hit) => publicPageUrl(hit.url) !== undefined)
      .slice(0, maxResults)
      .map((hit) => {
        const url = publicPageUrl(hit.url)!;
        return {
          url,
          title: hit.title?.trim().slice(0, 1_000) || url,
          snippet: (hit.snippet ?? "").slice(0, MAX_SNIPPET_CHARS),
        };
      });
  }

  async fetch(request: WebFetchRequest, context: AdapterContext): Promise<WebFetchResult> {
    const offset = clampOffset(request.offset);
    const maxChars = clampMaxChars(request.maxChars);
    const signal = this.signal(
      combineSignals(request.signal, context.signal),
      this.options.fetchTimeoutMs,
    );
    // Validate before disclosing the requested URL to the remote extraction service.
    const url = await assertSafeWebUrl(request.url, this.options.resolveHostname, signal);
    const page = await this.call(
      "scrape",
      { url: url.href, formats: ["markdown"], onlyMainContent: true },
      signal,
      pageSchema,
    );
    if (page.statusCode !== undefined && page.statusCode >= 400) {
      throw new Error(`Outcrawl: the page returned HTTP ${page.statusCode}`);
    }
    const pageUrl = (page.url && publicPageUrl(page.url)) || url.href;
    const markdown = page.markdown ?? "";
    if (!/\S/.test(markdown)) throw new Error("Outcrawl returned empty page content");
    return {
      url: pageUrl,
      title: page.metadata?.title?.trim().slice(0, 1_000) || pageUrl,
      ...pageWindow(markdown.slice(offset), maxChars, offset),
    };
  }

  private signal(parent: AbortSignal, timeoutMs = 60_000) {
    parent.throwIfAborted();
    return combineSignals(parent, AbortSignal.timeout(timeoutMs));
  }

  private async call<T>(
    path: "search" | "scrape",
    body: Record<string, unknown>,
    signal: AbortSignal,
    schema: z.ZodType<T>,
  ): Promise<T> {
    signal.throwIfAborted();
    if (!this.apiKey) throw new Error("Outcrawl: set OUTCRAWL_API_KEY on the API and worker");
    const fetchImpl = this.options.fetch ?? globalThis.fetch;
    const response = await withAbort(
      fetchImpl(`${ENDPOINT}/${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "User-Agent": USER_AGENT,
        },
        body: JSON.stringify(body),
        redirect: "error",
        signal,
      }),
      signal,
    );
    const text = new TextDecoder().decode(
      await readBodyCapped(response, MAX_RESPONSE_BYTES, signal),
    );
    if (!response.ok) {
      throw new Error(`Outcrawl ${path} failed (${response.status}): ${text.slice(0, 1_000)}`);
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("Invalid Outcrawl response");
    }
    const parsed = schema.safeParse(data);
    if (!parsed.success) throw new Error("Invalid Outcrawl response");
    return parsed.data;
  }
}

/** Keep citations public HTTP(S) URLs without embedded credentials. */
function publicPageUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if ((url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password)
      return url.href;
  } catch {
    /* Malformed provider URLs are not usable citations. */
  }
  return undefined;
}
