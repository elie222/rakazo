import { randomUUID } from "node:crypto";
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  Models,
  SimpleStreamOptions,
  Usage,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type {
  AgentRuntimeEvent,
  AgentUsage,
  ModelCallObserver,
  UsageOperationKind,
} from "@rakazo/adapter-kit";
import type { ContextBudget } from "./context-selection.js";
import { estimateModelContextTokens } from "./model-context.js";
import { requestedPiCacheWriteRetention, resolvePiCacheRetention } from "./pi-cache-retention.js";

/** Pi initializes absent usage to zero. Only raw numeric fields can prove reported zero. */
export type ReportedUsageFields = Set<keyof AgentUsage>;
const reportedCosts = new WeakMap<ReportedUsageFields, number>();
const reportedValues = new WeakMap<ReportedUsageFields, Map<keyof AgentUsage, number>>();
export function normalizePiUsage(
  usage: Partial<Usage> | undefined,
  model: Pick<Model<Api>, "cost">,
  reported: ReportedUsageFields = new Set(),
): AgentUsage {
  const token = (value: number | undefined, key: keyof AgentUsage) =>
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    (value > 0 || (reported.has(key) && (reportedValues.get(reported)?.get(key) ?? 0) === 0))
      ? value
      : null;
  const inputTokens = token(usage?.input, "inputTokens");
  const outputTokens = token(usage?.output, "outputTokens");
  const cacheReadTokens = token(usage?.cacheRead, "cacheReadTokens");
  const cacheWriteTokens = token(usage?.cacheWrite, "cacheWriteTokens");
  const rawTotal = reportedValues.get(reported)?.get("totalTokens");
  const buckets = [inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens];
  const derivedTotal = buckets.every((value) => value !== null)
    ? buckets.reduce<number>((sum, value) => sum + value!, 0)
    : null;
  // Pi synthesizes totals using zero placeholders for absent cache measurements.
  // Trust a reported total, or derive one only from a complete measured breakdown.
  const totalTokens = reported.has("totalTokens")
    ? token(rawTotal ?? usage?.totalTokens, "totalTokens")
    : derivedTotal !== null && Number.isSafeInteger(derivedTotal)
      ? derivedTotal
      : null;
  const costKnown =
    !!model.cost &&
    Object.values(model.cost).some((rate) => rate > 0) &&
    inputTokens !== null &&
    outputTokens !== null &&
    (model.cost.cacheRead === 0 || cacheReadTokens !== null) &&
    (model.cost.cacheWrite === 0 || cacheWriteTokens !== null);
  const providerCost = reportedCosts.get(reported);
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    cacheWrite1hTokens: token(usage?.cacheWrite1h, "cacheWrite1hTokens"),
    reasoningTokens: token(usage?.reasoning, "reasoningTokens"),
    totalTokens,
    costUsd:
      providerCost ??
      (costKnown && typeof usage?.cost?.total === "number" && Number.isFinite(usage.cost.total)
        ? usage.cost.total
        : null),
    costSource:
      providerCost !== undefined ? "provider-reported" : costKnown ? "pi-catalog-estimate" : null,
    pricingVersion: providerCost !== undefined ? null : costKnown ? "pi-ai-0.87.1" : null,
    usageSource: reported.size ? "provider-reported-via-pi" : "pi-normalized",
  };
}

/** Read only bounded SSE frames, retaining field presence, never provider text or payloads. */
export function usageReportingFetch(
  fetcher: typeof fetch,
  reported: ReportedUsageFields,
): typeof fetch {
  return async (input, init) => {
    const response = await fetcher(input, init);
    if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream"))
      return response;
    let buffer = "";
    let dropping = false;
    const decoder = new TextDecoder();
    const observe = (frame: string) => {
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data || data === "[DONE]") return;
      try {
        const event = JSON.parse(data);
        const usage = event.usage ?? event.response?.usage ?? event.message?.usage;
        if (!usage || typeof usage !== "object") return;
        const mark = (value: unknown, key: keyof AgentUsage) => {
          if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
            reported.add(key);
            const values = reportedValues.get(reported) ?? new Map();
            values.set(key, value);
            reportedValues.set(reported, values);
          }
        };
        const rawInput = usage.prompt_tokens ?? usage.input_tokens;
        const includesCache =
          usage.prompt_tokens !== undefined ||
          event.response !== undefined ||
          usage.input_tokens_details !== undefined;
        const rawRead =
          usage.prompt_tokens_details?.cached_tokens ??
          usage.input_tokens_details?.cached_tokens ??
          usage.prompt_cache_hit_tokens ??
          usage.cached_tokens;
        const rawWrite =
          usage.prompt_tokens_details?.cache_write_tokens ??
          usage.input_tokens_details?.cache_write_tokens;
        mark(
          typeof rawInput === "number" && includesCache
            ? Math.max(
                0,
                rawInput -
                  (typeof rawRead === "number" ? rawRead : 0) -
                  (typeof rawWrite === "number" ? rawWrite : 0),
              )
            : rawInput,
          "inputTokens",
        );
        mark(usage.completion_tokens ?? usage.output_tokens, "outputTokens");
        mark(usage.total_tokens, "totalTokens");
        if (typeof usage.cost === "number" && Number.isFinite(usage.cost) && usage.cost >= 0)
          reportedCosts.set(reported, usage.cost);
        mark(rawRead ?? usage.cache_read_input_tokens, "cacheReadTokens");
        mark(rawWrite ?? usage.cache_creation_input_tokens, "cacheWriteTokens");
        mark(usage.cache_creation?.ephemeral_1h_input_tokens, "cacheWrite1hTokens");
        mark(
          usage.completion_tokens_details?.reasoning_tokens ??
            usage.output_tokens_details?.reasoning_tokens,
          "reasoningTokens",
        );
      } catch {
        /* Invalid/non-JSON SSE frames are handled by the provider parser. */
      }
    };
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          controller.enqueue(chunk);
          buffer = (buffer + decoder.decode(chunk, { stream: true })).replace(/\r\n/g, "\n");
          let boundary = buffer.indexOf("\n\n");
          while (boundary >= 0) {
            const frame = buffer.slice(0, boundary);
            if (!dropping && frame.length <= 262144) observe(frame);
            dropping = false;
            buffer = buffer.slice(boundary + 2);
            boundary = buffer.indexOf("\n\n");
          }
          if (buffer.length > 262144) {
            buffer = buffer.slice(-1);
            dropping = true;
          }
        },
      }),
    );
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

/** One exclusive bucket per whole model call, including any answer alongside retrieval.
 * Setup, compaction and subagent attribution takes precedence. Only immediately consumed
 * trailing tool results count; an old search in retained history does not reclassify new work.
 */
function usageOperationKind(
  base: UsageOperationKind,
  context: Context,
  message: AssistantMessage,
): UsageOperationKind {
  if (base !== "answer") return base;
  const historyTool = (name: string) => name === "search_history" || name === "read_history";
  if (message.content.some((part) => part.type === "toolCall" && historyTool(part.name)))
    return "retrieval";
  for (let index = context.messages.length - 1; index >= 0; index--) {
    const previous = context.messages[index]!;
    if (previous.role !== "toolResult") break;
    if (historyTool(previous.toolName)) return "retrieval";
  }
  return base;
}

/** Guard and account every actual model invocation, including tools, failures and subagents. */
export function observedPiStream(
  models: Models,
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  push: (event: AgentRuntimeEvent) => void,
  observer?: ModelCallObserver,
  attribution: { operationKind: UsageOperationKind; agentId?: string } = {
    operationKind: "answer",
  },
  hooks?: {
    prepareContext?: (context: Context, model: Model<Api>) => Context;
    imageTokens?: ContextBudget["imageTokens"];
    onUsage?: (usage: AgentUsage) => void;
    recordUsage?: (event: Extract<AgentRuntimeEvent, { type: "usage" }>) => void | Promise<void>;
    /** Provider failures only; excludes context, reservations and usage settlement. */
    onProviderError?: (message: AssistantMessage) => void;
  },
) {
  const stream = createAssistantMessageEventStream();
  const reported: ReportedUsageFields = new Set();
  const callId = randomUUID();
  const emitUsage = async (usage: AgentUsage, operationKind = attribution.operationKind) => {
    const event = {
      type: "usage" as const,
      ...usage,
      provider: model.provider,
      model: model.id,
      callId,
      ...attribution,
      operationKind,
    };
    try {
      await hooks?.recordUsage?.(event);
    } catch (error) {
      push(event);
      throw error;
    }
    push({ ...event, ...(hooks?.recordUsage ? { accounted: true } : {}) });
  };
  void (async () => {
    let normalized: AgentUsage | null = null;
    let reservation: string | undefined;
    let started = false;
    let settled = false;
    let partialMessage: AssistantMessage | undefined;
    let providerError: unknown;
    let providerThrew = false;
    try {
      // A tool-budget or cancellation stop can reach Pi's next-turn hook after
      // aborting. It is not a model invocation and must not create unknown usage.
      options?.signal?.throwIfAborted();
      // Reject an unsupported declared control before reserving or making any request.
      const cacheRetention = resolvePiCacheRetention(model, options?.cacheRetention);
      const preparedContext = hooks?.prepareContext?.(context, model) ?? context;
      reservation = observer
        ? await observer.beforeCall({
            provider: model.provider,
            modelId: model.id,
            inputTokensEstimate: estimateModelContextTokens(preparedContext, hooks?.imageTokens),
            maxOutputTokens: options?.maxTokens ?? model.maxTokens,
            cacheWriteRetention: requestedPiCacheWriteRetention(model, cacheRetention),
          })
        : undefined;
      options?.signal?.throwIfAborted();
      started = true;
      // Some Pi adapters reject custom fetch outright. Only audited SSE families opt in.
      const collectRawUsage =
        /^(openai-|anthropic-)/.test(model.api) && !model.provider.startsWith("google");
      // Each guarded reservation covers one HTTP attempt, not hidden SDK retries.
      const streamOptions = {
        ...options,
        ...(cacheRetention ? { cacheRetention } : {}),
        ...(observer ? { maxRetries: 0 } : {}),
      };
      let upstream: ReturnType<Models["streamSimple"]>;
      try {
        upstream = models.streamSimple(
          model,
          preparedContext,
          collectRawUsage
            ? {
                ...streamOptions,
                fetch: usageReportingFetch(streamOptions?.fetch ?? globalThis.fetch, reported),
              }
            : streamOptions,
        );
      } catch (error) {
        providerThrew = true;
        providerError = error;
        throw error;
      }
      const events = hooks?.onProviderError
        ? (async function* () {
            try {
              yield* upstream;
            } catch (error) {
              providerThrew = true;
              providerError = error;
              throw error;
            }
          })()
        : upstream;
      for await (const event of events) {
        if (hooks?.onProviderError) {
          partialMessage =
            event.type === "done"
              ? event.message
              : event.type === "error"
                ? event.error
                : event.partial;
        }
        if (event.type === "done" || event.type === "error") {
          const message = event.type === "done" ? event.message : event.error;
          normalized = normalizePiUsage(message.usage, model, reported);
          await emitUsage(
            normalized,
            usageOperationKind(attribution.operationKind, preparedContext, message),
          );
          try {
            hooks?.onUsage?.(normalized);
          } catch {
            /* Cache telemetry cannot discard accounted spend. */
          }
          if (observer && reservation !== undefined) {
            settled = true;
            await observer.afterCall(reservation, normalized);
          }
        }
        if (event.type === "error") hooks?.onProviderError?.(event.error);
        stream.push(event);
      }
      stream.end(await upstream.result());
    } catch (error) {
      let terminalError = error;
      if (started && normalized === null) {
        try {
          await emitUsage(normalizePiUsage(undefined, model));
        } catch (accountingError) {
          terminalError = accountingError;
        }
      }
      if (observer && reservation !== undefined && !settled) {
        // Keep the reservation alive until settlement finishes, before exposing termination.
        settled = true;
        try {
          await observer.afterCall(reservation, normalized);
        } catch {
          /* Already failing. */
        }
      }
      // Preserve a proper Pi terminal message so Agent and cancellation both settle.
      const message = {
        role: "assistant" as const,
        content: hooks?.onProviderError ? (partialMessage?.content ?? []) : [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "error" as const,
        errorMessage:
          terminalError instanceof Error ? terminalError.message : String(terminalError),
        timestamp: Date.now(),
      };
      if (providerThrew && terminalError === providerError) hooks?.onProviderError?.(message);
      stream.push({ type: "error", reason: "error", error: message });
      stream.end(message);
    }
  })();
  return stream;
}
