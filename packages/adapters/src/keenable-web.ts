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
import type { RemoteTransportDependencies } from "./remote-mcp.js";
import { callRemoteMcpTool } from "./remote-mcp.js";
import { clampMaxChars, clampMaxResults, clampOffset, pageWindow } from "./web-limits.js";
import { assertSafeWebUrl, withAbort } from "./web-ssrf.js";

const ENDPOINT = "https://api.keenable.ai/mcp";
const USER_AGENT = "Rakazo/0.1 (+https://github.com/elie222/rakazo; web tools)";
const MAX_SNIPPET_CHARS = 8_000;
// Even escaped multibyte text stays inside the transport's 1 MB result limit.
const KEENABLE_MAX_READ_CHARS = 100_000;
const searchSchema = z.object({
  results: z.array(
    z.object({
      url: z.string().max(8_192),
      title: z.string().nullable().optional(),
      snippet: z.string().nullable().optional(),
      description: z.string().nullable().optional(),
    }),
  ),
});
const pageSchema = z.object({
  url: z.string().max(8_192),
  title: z.string().nullable().optional(),
  content: z.string(),
});
const envelopeSchema = z.object({
  isError: z.boolean().optional(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
});

export type KeenableWebOptions = RemoteTransportDependencies & {
  searchTimeoutMs?: number;
  fetchTimeoutMs?: number;
};

/** Optional MCP backend for the existing builtin web tools; keyless unless KEENABLE_API_KEY is set. */
export class KeenableWebProvider implements WebProvider {
  private readonly apiKey = process.env.KEENABLE_API_KEY?.trim();

  constructor(private readonly options: KeenableWebOptions = {}) {}

  /** Advertise the same optional web capabilities as other WebProvider adapters. */
  describe() {
    return {
      id: "keenable",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { search: true, fetch: true, keyless: true, native: false, readability: true },
    };
  }

  /** Return bounded search snippets through the existing builtin tool contract. */
  async search(request: WebSearchRequest, context: AdapterContext): Promise<WebSearchHit[]> {
    const query = request.query.trim();
    if (!query) throw new Error("query is required");
    const maxResults = clampMaxResults(request.maxResults);
    const signal = this.signal(
      combineSignals(request.signal, context.signal),
      this.options.searchTimeoutMs,
    );
    const response = await this.call(
      "search_web_pages",
      { query, max_results: maxResults },
      signal,
      searchSchema,
    );
    return response.results
      .filter((page) => publicPageUrl(page.url) !== undefined)
      .slice(0, maxResults)
      .map((page) => {
        const url = publicPageUrl(page.url)!;
        return {
          url,
          title: page.title?.trim().slice(0, 1_000) || url,
          snippet: (page.snippet || page.description || "").slice(0, MAX_SNIPPET_CHARS),
        };
      });
  }

  /** Extract readable page markdown within the shared fetch limit. */
  async fetch(request: WebFetchRequest, context: AdapterContext): Promise<WebFetchResult> {
    const maxChars = clampMaxChars(request.maxChars);
    const offset = clampOffset(request.offset);
    // Keenable has no offset, so the skipped prefix still crosses the transport's size limit.
    if (offset + maxChars > KEENABLE_MAX_READ_CHARS) {
      throw new Error(
        `Keenable can read the first ${KEENABLE_MAX_READ_CHARS} characters of a page.`,
      );
    }
    const signal = this.signal(
      combineSignals(request.signal, context.signal),
      this.options.fetchTimeoutMs,
    );
    // Validate before disclosing the requested URL to the remote extraction service.
    const url = await assertSafeWebUrl(request.url, this.options.resolveHostname, signal);
    // Ask for one extra character so a longer page keeps the truncation flag.
    const page = await this.call(
      "fetch_page_content",
      { url: url.href, max_chars: offset + maxChars + 1 },
      signal,
      pageSchema,
    );
    const pageUrl = publicPageUrl(page.url);
    if (!pageUrl) throw new Error("Keenable returned an invalid page URL");
    if (!/\S/.test(page.content)) throw new Error("Keenable returned empty page content");
    return {
      url: pageUrl,
      title: page.title?.trim().slice(0, 1_000) || pageUrl,
      ...pageWindow(page.content.slice(offset), maxChars, offset),
    };
  }

  /** Combine caller cancellation with the provider deadline. */
  private signal(parent: AbortSignal, timeoutMs = 30_000) {
    parent.throwIfAborted();
    return combineSignals(parent, AbortSignal.timeout(timeoutMs));
  }

  /** Call one Keenable tool through the guarded transport and validate its JSON result. */
  private async call<T>(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    schema: z.ZodType<T>,
  ): Promise<T> {
    signal.throwIfAborted();
    const headers: Record<string, string> = {
      "User-Agent": USER_AGENT,
      "X-Keenable-Title": "rakazo",
    };
    if (this.apiKey) headers["X-API-Key"] = this.apiKey;
    const raw = await withAbort(
      callRemoteMcpTool({ ...this.options, endpoint: ENDPOINT, headers, signal }, name, {
        ...args,
        output_format: "json",
      }),
      signal,
    );
    // A limited serialized envelope fails here instead of becoming page text.
    const envelope = envelopeSchema.safeParse(raw);
    if (!envelope.success) throw new Error("Invalid Keenable MCP response");
    const text = envelope.data.content
      .filter((item) => item.type === "text")
      .map((item) => item.text ?? "")
      .join("\n");
    if (envelope.data.isError)
      throw new Error(`Keenable: ${text.slice(0, 1_000) || "tool request failed"}`);
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("Invalid Keenable MCP response");
    }
    const response = schema.safeParse(data);
    if (!response.success) throw new Error("Invalid Keenable MCP response");
    return response.data;
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
