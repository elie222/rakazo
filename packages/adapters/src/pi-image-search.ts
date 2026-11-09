import type { Context } from "@earendil-works/pi-ai";
import type { ImageSearchHit, ImageSearchResult } from "@rakazo/adapter-kit";
import * as z from "zod";
import { CHATGPT_OAUTH_PROVIDER } from "./pi-oauth.js";
import { reliableModelStream } from "./pi-runtime-stream.js";
import type { ToolHost } from "./pi-runtime-tools.js";
import { observedPiStream } from "./pi-usage.js";
import { clampMaxResults, MAX_WEB_SEARCH_RESULTS } from "./web-limits.js";
import { isBlockedHostname } from "./web-ssrf.js";

const MAX_URL_LENGTH = 4096;
const MAX_TITLE_LENGTH = 500;
const MAX_QUERY_LENGTH = 2000;

const completedSearchSchema = z.object({
  type: z.literal("response.output_item.done"),
  item: z.object({
    id: z.string().min(1).max(200),
    type: z.literal("web_search_call"),
    status: z.literal("completed"),
    results: z.array(z.unknown()).optional(),
  }),
});
const imageResultSchema = z.object({
  type: z.literal("image_result"),
  image_url: z.string(),
  source_website_url: z.string(),
  caption: z.unknown().optional(),
  thumbnail_url: z.unknown().optional(),
});
const payloadSchema = z.looseObject({ include: z.array(z.string()).optional() });

export function supportsModelImageSearch(provider: string): boolean {
  return provider === CHATGPT_OAUTH_PROVIDER;
}

function screenedResultUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > MAX_URL_LENGTH) return undefined;
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username ||
      url.password ||
      isBlockedHostname(url.hostname) ||
      url.href.length > MAX_URL_LENGTH
    )
      return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function imageSearchHit(value: unknown): ImageSearchHit | undefined {
  const parsed = imageResultSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const imageUrl = screenedResultUrl(parsed.data.image_url);
  const sourceUrl = screenedResultUrl(parsed.data.source_website_url);
  if (!imageUrl || !sourceUrl) return undefined;
  const title =
    typeof parsed.data.caption === "string"
      ? parsed.data.caption.trim().slice(0, MAX_TITLE_LENGTH)
      : undefined;
  const thumbnailUrl = screenedResultUrl(parsed.data.thumbnail_url);
  return {
    imageUrl,
    sourceUrl,
    ...(title ? { title } : {}),
    ...(thumbnailUrl ? { thumbnailUrl } : {}),
  };
}

export async function executeImageSearch(
  host: ToolHost,
  args: Record<string, unknown>,
): Promise<ImageSearchResult> {
  const target = host.activeModel;
  if (!supportsModelImageSearch(target.model.provider))
    return { error: "Image search is unavailable for this model." };
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query || query.length > MAX_QUERY_LENGTH)
    return { error: "query must contain between 1 and 2000 characters" };
  const maxResults = clampMaxResults(args.maxResults);
  const completed = new Map<string, ImageSearchHit[]>();
  const context: Context = {
    systemPrompt: "Search for existing public images matching the query.",
    messages: [{ role: "user", content: query, timestamp: Date.now() }],
  };
  try {
    host.signal.throwIfAborted();
    const stream = reliableModelStream(
      target.models,
      target.model,
      context,
      {
        signal: host.signal,
        fetch: host.modelFetch,
        apiKey: target.apiKey,
        reasoning: "low",
        onPayload: (payload) => {
          const body = payloadSchema.parse(payload);
          return {
            ...body,
            tools: [
              {
                type: "web_search",
                search_content_types: ["image"],
                image_settings: { max_results: maxResults, caption: true },
              },
            ],
            tool_choice: { type: "web_search" },
            include: [...new Set([...(body.include ?? []), "web_search_call.results"])],
          };
        },
        onProviderStreamEvent: (event) => {
          const parsed = completedSearchSchema.safeParse(event);
          if (!parsed.success) return;
          const { id, results } = parsed.data.item;
          if (!completed.has(id) && completed.size >= MAX_WEB_SEARCH_RESULTS) return;
          const hits = new Map<string, ImageSearchHit>();
          for (const entry of (results ?? []).slice(0, 100)) {
            const hit = imageSearchHit(entry);
            if (hit && !hits.has(hit.imageUrl)) hits.set(hit.imageUrl, hit);
            if (hits.size >= maxResults) break;
          }
          completed.set(id, [...hits.values()]);
        },
      },
      512,
      () => target.credentials?.accessToken ?? target.apiKey,
      (options) =>
        observedPiStream(
          target.models,
          target.model,
          context,
          options,
          (event) => host.queue.push(event),
          target.config.callObserver ?? host.modelCallObserver,
          {
            operationKind: "retrieval",
            userId: host.context?.userId,
            runId: host.request.runId,
            agentId: host.agentNamespace,
          },
          { recordUsage: host.request.onUsage },
        ),
    );
    for await (const _event of stream) {
    }
    const message = await stream.result();
    if (host.signal.aborted || message.stopReason === "aborted")
      return { error: "Image search was stopped." };
    if (message.stopReason !== "stop") return { error: "Image search failed." };
    if (!completed.size) return { error: "Image search returned no completed search." };
    const unique = new Map<string, ImageSearchHit>();
    for (const hits of completed.values()) {
      for (const hit of hits) {
        if (!unique.has(hit.imageUrl)) unique.set(hit.imageUrl, hit);
        if (unique.size >= maxResults) return { results: [...unique.values()] };
      }
    }
    return { results: [...unique.values()] };
  } catch {
    return { error: host.signal.aborted ? "Image search was stopped." : "Image search failed." };
  }
}
