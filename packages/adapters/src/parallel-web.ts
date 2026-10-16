import { createHash } from "node:crypto";
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
import { clampMaxChars, clampMaxResults } from "./web-limits.js";
import { assertSafeWebUrl, withAbort } from "./web-ssrf.js";

const ENDPOINT = "https://search.parallel.ai/mcp";
const USER_AGENT = "Rakazo/0.1 (+https://github.com/elie222/rakazo; web tools)";
const pageSchema = z.object({
  url: z.string(),
  title: z.string().nullable().optional(),
  excerpts: z.array(z.string()),
  full_content: z.string().nullable().optional(),
});
const responseSchema = z.object({
  results: z.array(pageSchema),
  errors: z.array(z.object({ error_type: z.string() })).optional(),
});

export type ParallelWebOptions = RemoteTransportDependencies & {
  searchTimeoutMs?: number;
  fetchTimeoutMs?: number;
};

/** Optional anonymous MCP backend for the existing builtin web tools. */
export class ParallelWebProvider implements WebProvider {
  constructor(private readonly options: ParallelWebOptions = {}) {}

  describe() {
    return {
      id: "parallel",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { search: true, fetch: true, keyless: true, native: false, readability: true },
    };
  }

  async search(request: WebSearchRequest, context: AdapterContext): Promise<WebSearchHit[]> {
    const query = request.query.trim();
    if (!query) throw new Error("query is required");
    const signal = this.signal(
      combineSignals(request.signal, context.signal),
      this.options.searchTimeoutMs,
    );
    const response = await this.call(
      "web_search",
      { objective: query, search_queries: [query] },
      context,
      signal,
    );
    return response.results
      .filter((page) => publicPageUrl(page.url) !== undefined)
      .slice(0, clampMaxResults(request.maxResults))
      .map((page) => ({
        url: publicPageUrl(page.url)!,
        title: page.title?.trim() || page.url,
        snippet: page.excerpts.join("\n\n"),
      }));
  }

  async fetch(request: WebFetchRequest, context: AdapterContext): Promise<WebFetchResult> {
    const signal = this.signal(
      combineSignals(request.signal, context.signal),
      this.options.fetchTimeoutMs,
    );
    // Validate before disclosing the requested URL to the remote extraction service.
    const url = await assertSafeWebUrl(request.url, this.options.resolveHostname, signal);
    const response = await this.call(
      "web_fetch",
      { urls: [url.href], full_content: true },
      context,
      signal,
    );
    const page = response.results[0];
    if (!page)
      throw new Error(
        `Parallel page fetch failed: ${response.errors?.[0]?.error_type ?? "no content"}`,
      );
    const pageUrl = publicPageUrl(page.url);
    if (!pageUrl) throw new Error("Parallel returned an invalid page URL");
    const text = page.full_content ?? page.excerpts.join("\n\n");
    if (!text.trim()) throw new Error("Parallel returned empty page content");
    const maxChars = clampMaxChars(request.maxChars);
    const truncated = text.length > maxChars;
    return {
      url: pageUrl,
      title: page.title?.trim() || pageUrl,
      text: truncated ? `${text.slice(0, maxChars)}\n\n[Content truncated]` : text,
      truncated,
    };
  }

  private signal(parent: AbortSignal, timeoutMs = 30_000) {
    parent.throwIfAborted();
    return combineSignals(parent, AbortSignal.timeout(timeoutMs));
  }

  private async call(
    name: string,
    args: Record<string, unknown>,
    context: AdapterContext,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    // One continuing bot conversation shares rate-limit accounting without sending raw IDs.
    const sessionId = createHash("sha256")
      .update(
        JSON.stringify([
          context.spaceId,
          context.userId,
          context.botId ?? context.runId ?? context.operationId,
        ]),
      )
      .digest("hex");
    const raw = await withAbort(
      callRemoteMcpTool(
        { ...this.options, endpoint: ENDPOINT, headers: { "User-Agent": USER_AGENT }, signal },
        name,
        { ...args, session_id: sessionId },
      ),
      signal,
    );
    const envelope = z
      .object({
        isError: z.boolean().optional(),
        structuredContent: z.unknown().optional(),
        content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
      })
      .safeParse(raw);
    if (!envelope.success) throw new Error("Invalid Parallel MCP response");
    const text =
      envelope.data.content
        ?.filter((item) => item.type === "text")
        .map((item) => item.text ?? "")
        .join("\n") ?? "";
    if (envelope.data.isError)
      throw new Error(`Parallel: ${text.slice(0, 1000) || "tool request failed"}`);
    let data = envelope.data.structuredContent;
    if (data === undefined) {
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error("Invalid Parallel MCP response");
      }
    }
    const response = responseSchema.safeParse(data);
    if (!response.success) throw new Error("Invalid Parallel MCP response");
    return response.data;
  }
}

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
