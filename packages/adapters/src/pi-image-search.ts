import type { Context } from "@earendil-works/pi-ai";
import type { ImageSearchHit, ImageSearchResult } from "@rakazo/adapter-kit";
import { normalizeRunError, redactSecrets } from "@rakazo/core";
import { normalizedHttpUrl } from "@rakazo/core/egress";
import { getLogger, redactSensitiveText } from "@rakazo/logging";
import { sanitizedError } from "@rakazo/logging/monitoring";
import * as z from "zod";
import { CHATGPT_OAUTH_PROVIDER } from "./pi-oauth.js";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "./pi-openai-compatible-provider.js";
import { TOOL_RESULT_TEXT_LIMIT } from "./pi-runtime-limits.js";
import { reliableModelStream } from "./pi-runtime-stream.js";
import type { ToolHost } from "./pi-runtime-tools.js";
import { observedPiStream } from "./pi-usage.js";
import { clampMaxResults, MAX_WEB_SEARCH_RESULTS } from "./web-limits.js";
import { isBlockedHostname } from "./web-ssrf.js";

export const IMAGE_SEARCH_UNAVAILABLE = "Image search is unavailable for this model.";

const MAX_URL_LENGTH = 4096;
const MAX_TITLE_LENGTH = 500;
const MAX_QUERY_LENGTH = 2000;

const completedSearchSchema = z.object({
  type: z.literal("response.output_item.done"),
  item: z.object({
    id: z.string().min(1).max(200),
    type: z.literal("web_search_call"),
    status: z.literal("completed"),
    // Validate the envelope without copying entries that will be discarded below.
    results: z.custom<unknown[]>(Array.isArray).optional(),
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

export function supportsModelImageSearch(provider: string, apiProtocol?: string): boolean {
  return (
    provider === CHATGPT_OAUTH_PROVIDER ||
    (provider === OPENAI_COMPATIBLE_PROVIDER_ID && apiProtocol === "responses")
  );
}

function screenedResultUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > MAX_URL_LENGTH) return undefined;
  const normalized = normalizedHttpUrl(value);
  if (!normalized || normalized.length > MAX_URL_LENGTH) return undefined;
  const url = new URL(normalized);
  if (url.username || url.password || isBlockedHostname(url.hostname)) return undefined;
  return normalized;
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
  if (!supportsModelImageSearch(target.model.provider, target.config.apiProtocol))
    return { error: IMAGE_SEARCH_UNAVAILABLE };
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query || query.length > MAX_QUERY_LENGTH)
    return { error: "query must contain between 1 and 2000 characters" };
  const reportFailure = (error: unknown) => {
    const diagnostic = normalizeRunError(
      (error instanceof Error ? error.message : typeof error === "string" ? error : "").slice(
        0,
        2000,
      ),
    );
    getLogger().warn("image_search.failed", {
      "run.id": host.request.runId,
      "model.id": target.model.id,
      "model.provider": target.model.provider,
      "provider.status": diagnostic.status,
      "failure.kind": diagnostic.kind ?? "unknown",
      error: sanitizedError(error, (text) =>
        redactSensitiveText(
          redactSecrets(text, [
            query,
            ...(host.request.secrets ?? []),
            target.apiKey ?? "",
            target.credentials?.accessToken ?? "",
          ]),
        ).slice(0, 2000),
      ),
    });
    return { error: "Image search failed." };
  };
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
    if (message.stopReason !== "stop" && message.stopReason !== "length")
      return reportFailure(
        new Error(message.errorMessage || `Search stopped with ${message.stopReason}.`),
      );
    if (!completed.size) {
      reportFailure(new Error("No completed structured image search item."));
      return { error: "Image search returned no completed search." };
    }
    const unique = new Map<string, ImageSearchHit>();
    for (const hits of completed.values()) {
      for (const hit of hits) {
        if (unique.has(hit.imageUrl)) continue;
        unique.set(hit.imageUrl, hit);
        if (JSON.stringify({ results: [...unique.values()] }).length > TOOL_RESULT_TEXT_LIMIT) {
          unique.set(hit.imageUrl, { imageUrl: hit.imageUrl, sourceUrl: hit.sourceUrl });
          if (JSON.stringify({ results: [...unique.values()] }).length > TOOL_RESULT_TEXT_LIMIT)
            unique.delete(hit.imageUrl);
        }
        if (unique.size >= maxResults) return { results: [...unique.values()] };
      }
    }
    return { results: [...unique.values()] };
  } catch (error) {
    return host.signal.aborted ? { error: "Image search was stopped." } : reportFailure(error);
  }
}
