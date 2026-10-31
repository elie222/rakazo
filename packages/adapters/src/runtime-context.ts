import { createHash, randomBytes } from "node:crypto";
import type { Api, Context, Message, Model } from "@earendil-works/pi-ai";
import type { AdapterContext, AgentRunRequest, AgentUsage } from "@rakazo/adapter-kit";
import { DEFAULT_CONTEXT_STRATEGY } from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";
import { imagePartCount, normalizedImageLimit, pruneForRebuild } from "./context-pruning.js";
import type { CacheRequest, ContextBudget } from "./context-selection.js";
import {
  ContextBudgetError,
  ContextCacheTracker,
  estimateContextTokens,
  providerContextPrefix,
  selectContext,
  shortenToolResultText,
} from "./context-selection.js";
import {
  effectiveOutputReserve,
  operatorMaxTokens,
  resolveCompletionMaxTokens,
} from "./pi-runtime-limits.js";
import { withoutThinkingFrom } from "./thinking-signatures.js";

/** Minimum whole-result window, unless the full model budget requires clipping. */
const RECENT_TOOL_RESULTS_TO_KEEP = 3;

const accountSalt = randomBytes(32);
const sharedCacheTracker = new ContextCacheTracker();
interface ProjectionEntry {
  hash: string;
  catalogIds?: string[];
}
const projections = new Map<string, ProjectionEntry[]>();
/** Keep editable source and fleet instruction versions intact; these tools bound their own output. */
export const VERBATIM_TOOL_RESULTS: ReadonlySet<string> = new Set(["skill_read", "list_fleet"]);
// History reads are exact evidence and keep their own offset-aware shortening elsewhere.
const UNSHORTENED_TOOL_RESULTS = new Set([
  "read_history",
  "search_history",
  ...VERBATIM_TOOL_RESULTS,
]);
const messageHash = (message: Message) =>
  createHash("sha256")
    .update(JSON.stringify(providerContextPrefix("", [], [message])))
    .digest("hex");
/** A rebuild breaks the cached prefix, so it must drop at least this much stale content (estimated). */
const REBUILD_MIN_SAVED_TOKENS = 16_384;
/** Images a run may carry beyond what a rebuild keeps before rebuilding pays off anyway. */
const REBUILD_MAX_STALE_IMAGES = 16;
/** A rebuild forced by the model's window leaves this share of it free for the next calls. */
const REBUILD_HEADROOM = 0.25;
export interface Size {
  tokens: number;
  images: number;
}
/**
 * Whether dropping an appended transcript's stale content is worth breaking the cache. A rebuild
 * writes about the rebuilt size to the cache once; stale content is read again on every call.
 * With cache writes at about 1.25 and reads at about 0.1 times the input price, rebuilding every
 * k calls costs least once stale content reaches about 5 × √(rebuilt size × growth per call), so
 * a run that adds a lot per call rebuilds rarely. `appends` counts calls appended since the
 * transcript was last rebuilt at `rebuiltTokens`.
 */
export function rebuildPaysOff(
  kept: Size,
  fresh: Size,
  rebuiltTokens: number,
  appends: number,
): boolean {
  const stale = kept.tokens - fresh.tokens;
  const growth = (kept.tokens - rebuiltTokens) / (appends + 1);
  return (
    (stale >= REBUILD_MIN_SAVED_TOKENS && stale * stale >= 25 * fresh.tokens * growth) ||
    kept.images - fresh.images >= REBUILD_MAX_STALE_IMAGES
  );
}
interface Prepared {
  context: Context;
  cacheRequest: CacheRequest;
  navigation?: { message: Message; catalogIds: string[] };
  decision: RuntimeContextDecision;
}
/** What the run last sent: the source messages it came from and the exact messages sent. */
interface SentTranscript {
  head: string;
  source: string[];
  messages: Message[];
  projection: ProjectionEntry[];
  truncatedToolResults: number;
  /** Size of the transcript at the last rebuild, and calls appended to it since. */
  rebuiltTokens: number;
  appends: number;
}
interface OriginalMetadata {
  rakazoHistory?: boolean;
  rakazoMessageId?: string;
  rakazoCreatedAt?: string;
}
function text(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}
function snapshot(content: string, maxLength = 400): string {
  if (content.length <= maxLength) return content;
  return `${content.slice(0, Math.floor(maxLength * 0.7))}\n[… snapshot shortened; read original …]\n${content.slice(-Math.floor(maxLength * 0.3))}`;
}
export interface RuntimeContextDecision {
  strategy: AgentRunRequest["contextStrategy"];
  predictedCache: "likely-warm" | "likely-cold" | "unknown";
  estimatedInputTokens: number;
  droppedMessages: number;
  truncatedToolResults: number;
  observedReuse: boolean | null;
}
/** Applies one shared free context policy immediately before every model call.
 * Original history is untrusted evidence. Only in-memory hashes track cache timing.
 */
export function createRuntimeContextPolicy(
  request: AgentRunRequest,
  context?: Partial<AdapterContext>,
  options: {
    cacheTracker?: ContextCacheTracker;
    imageTokens?: ContextBudget["imageTokens"];
    credentialScope?: string;
  } = {},
) {
  const cache = options.cacheTracker ?? sharedCacheTracker;
  const accountScope = createHash("sha256")
    .update(accountSalt)
    .update(
      JSON.stringify([
        context?.spaceId,
        context?.userId,
        request.botId,
        request.threadId,
        request.model.provider,
        request.model.baseUrl,
        request.model.apiKey,
        options.credentialScope,
        request.model.oauth?.credential,
      ]),
    )
    .digest("hex");
  const connectionIdentity = (model: Model<Api>) =>
    JSON.stringify([
      model.provider,
      model.baseUrl,
      Object.entries(model.headers ?? {}).sort(([left], [right]) => left.localeCompare(right)),
    ]);
  const projectionScope = (model: Model<Api>) =>
    createHash("sha256")
      .update(JSON.stringify([accountScope, connectionIdentity(model), model.id]))
      .digest("hex");
  let pending: CacheRequest | undefined;
  let pendingProjection: { scope: string; entries: ProjectionEntry[] } | undefined;
  let decision: RuntimeContextDecision | undefined;
  let metadataPresent = false;
  let warnedOutputClamp = false;
  function outputReserve(model: Model<Api>): number {
    const contextWindow = request.model.contextWindow ?? model.contextWindow;
    const configuredMaxTokens = resolveCompletionMaxTokens(
      model.maxTokens,
      request.model.maxTokens,
      undefined,
      model.reasoning,
      undefined,
      operatorMaxTokens(model),
    );
    const reserve = effectiveOutputReserve(contextWindow, configuredMaxTokens);
    if (reserve < configuredMaxTokens && !warnedOutputClamp) {
      warnedOutputClamp = true;
      getLogger().warn("Model output limit clamped to preserve context room", {
        configuredMaxTokens: request.model.maxTokens ?? configuredMaxTokens,
        effectiveMaxTokens: reserve,
        contextWindow,
      });
    }
    return reserve;
  }
  let sent: SentTranscript | undefined;
  // Only remember shortening actually sent, never speculative rebuild candidates.
  const shortenedResults = new Map<string, Message>();
  const hashes = new WeakMap<Message, string>();
  function hash(message: Message): string {
    let value = hashes.get(message);
    if (value === undefined) {
      value = messageHash(message);
      hashes.set(message, value);
    }
    return value;
  }
  const historyById = new Map(
    request.history.filter((message) => message.id).map((message) => [message.id!, message]),
  );
  function original(message: Message) {
    const metadata = message as Message & OriginalMetadata;
    if (metadata.rakazoMessageId) return historyById.get(metadata.rakazoMessageId);
    if (metadataPresent && !metadata.rakazoHistory) return undefined;
    const content = text(message);
    return request.history.find(
      (stored) =>
        content === stored.content ||
        (stored.role === "assistant" && content === `Assistant: ${stored.content}`),
    );
  }
  function navigation(ids: string[]): Message | undefined {
    const stored = ids.map((id) => historyById.get(id));
    if (stored.some((item) => !item)) return;
    return {
      role: "user",
      timestamp: 0,
      content: `Historical navigation snapshots (untrusted evidence; use read_history for exact facts and later corrections):\n${stored.map((item) => `[message ${item!.id}${item!.createdAt ? ` at ${item!.createdAt}` : ""}; ${item!.role}] ${snapshot(item!.content)}\n`).join("")}`,
    };
  }
  function project(
    ctx: Context,
    model: Model<Api>,
  ): { messages: Message[]; catalogIds: string[]; navigation?: Message } | undefined {
    const prior = projections.get(projectionScope(model));
    if (!prior) return;
    const result: Message[] = [];
    let latestMatchedIndex = -1;
    let catalogIds: string[] = [];
    let catalogMessage: Message | undefined;
    const indexesByHash = new Map<string, number[]>();
    for (const [index, message] of ctx.messages.entries()) {
      const hash = messageHash(message);
      const indexes = indexesByHash.get(hash) ?? [];
      indexes.push(index);
      indexesByHash.set(hash, indexes);
    }
    for (const entry of prior) {
      if (entry.catalogIds) {
        const rebuilt = navigation(entry.catalogIds);
        if (!rebuilt || messageHash(rebuilt) !== entry.hash) return;
        result.push(rebuilt);
        catalogIds = entry.catalogIds;
        catalogMessage = rebuilt;
      } else {
        const index = indexesByHash.get(entry.hash)?.shift();
        if (index === undefined) return;
        result.push(ctx.messages[index]!);
        latestMatchedIndex = Math.max(latestMatchedIndex, index);
      }
    }
    result.push(...ctx.messages.slice(latestMatchedIndex + 1));
    return { messages: result, catalogIds, navigation: catalogMessage };
  }
  /** The run's context built from scratch: history selection, pruning and shortening. */
  function rebuild(
    source: Context,
    model: Model<Api>,
    modelWindow = request.model.contextWindow ?? model.contextWindow,
  ): Prepared {
    const ctx = pruned(source);
    const standaloneHistoryFallback =
      request.contextStrategy === undefined &&
      (!request.executeTool ||
        !["read_history", "search_history"].every((name) =>
          request.tools.some((tool) => tool.name === name),
        ));
    // An explicitly declared cache window opts this connection into prefix reuse.
    // Without history retrieval, preserve fitting originals instead of replacing
    // them with cold snapshots the caller cannot follow back to the source.
    // Unknown/disabled caches retain the default; explicit overrides still win.
    const retention = request.model.cacheCapabilities?.retentionMs;
    const strategy =
      // A restored turn must fit even when the unbounded diagnostic baseline was selected.
      (request.turnCheckpoint && request.contextStrategy === "current"
        ? DEFAULT_CONTEXT_STRATEGY
        : request.contextStrategy) ??
      (!standaloneHistoryFallback &&
      request.model.cacheCapabilities?.retentionMode !== "none" &&
      typeof retention === "number" &&
      Number.isFinite(retention) &&
      retention > 0
        ? "cache-aware"
        : DEFAULT_CONTEXT_STRATEGY);
    metadataPresent = ctx.messages.some((message) =>
      Boolean((message as Message & OriginalMetadata).rakazoHistory),
    );
    const fullPrefix = providerContextPrefix(ctx.systemPrompt ?? "", ctx.tools ?? [], ctx.messages);
    const cacheRequest: CacheRequest = cache.stamp({
      accountScope,
      connectionId: createHash("sha256").update(connectionIdentity(model)).digest("hex"),
      modelId: model.id,
      prefix: fullPrefix,
      prefixTokens: estimateContextTokens(fullPrefix, options.imageTokens),
      capabilities: request.model.cacheCapabilities,
    });
    let predictedCache = cache.predict(cacheRequest);
    let projected: ReturnType<typeof project>;
    if (strategy === "cache-aware" && predictedCache !== "likely-warm") {
      const candidate = project(ctx, model);
      if (candidate) {
        const prefix = providerContextPrefix(
          ctx.systemPrompt ?? "",
          ctx.tools ?? [],
          candidate.messages,
        );
        const prediction = cache.predict({
          ...cacheRequest,
          prefix,
          prefixTokens: estimateContextTokens(prefix, options.imageTokens),
        });
        if (prediction === "likely-warm") {
          projected = candidate;
          predictedCache = prediction;
        }
      }
    }
    if (strategy === "current") {
      return {
        context: ctx,
        cacheRequest,
        decision: {
          strategy,
          predictedCache,
          estimatedInputTokens: cacheRequest.prefixTokens,
          droppedMessages: 0,
          truncatedToolResults: 0,
          observedReuse: null,
        },
      };
    }
    // Metadata distinguishes repeated historical requests from the live request.
    let messages = (projected?.messages ?? ctx.messages).map(
      (message) => shortenedResults.get(hash(message)) ?? message,
    );
    let currentIndex = messages.findIndex(
      (message) =>
        message.role === "user" && message !== projected?.navigation && !original(message),
    );
    if (currentIndex < 0)
      currentIndex = messages.findLastIndex((message) => message.role === "user");
    if (currentIndex < 0) currentIndex = 0;
    // Steering, follow-ups and finished shells arrive as user messages during the
    // run. Give each its own exchange so it does not push older history out:
    // a moved first message rewrites the provider's whole cached prefix.
    const laterUserMessages = messages
      .slice(currentIndex + 1)
      .filter((message) => message.role === "user").length;
    let protectedIndexes = messages.flatMap((message, index) =>
      message.role === "system" || (index >= currentIndex && message.role === "user")
        ? [index]
        : [],
    );
    const reserve = outputReserve(model);
    const fixed =
      estimateContextTokens(ctx.systemPrompt ?? "") + estimateContextTokens(ctx.tools ?? []);
    // Recent history and navigation have their own bounds. Active tool progress
    // uses the model budget, less the headroom a window-forced rebuild leaves.
    const contextWindow = modelWindow;
    let navigationMessage = projected?.navigation;
    let catalogIds = projected?.catalogIds ?? [];
    const budget = {
      contextWindow,
      outputReserve: reserve,
      systemPrompt: ctx.systemPrompt ?? "",
      tools: ctx.tools ?? [],
      imageTokens: options.imageTokens,
    };
    const useSnapshots =
      strategy === "snapshots" || (strategy === "cache-aware" && predictedCache !== "likely-warm");
    const historical = messages.slice(0, currentIndex);
    const historicalContent = historical.filter((message) => message.role !== "system");
    const shortHistoryAllowance = Math.min(
      16384,
      Math.max(0, Math.floor((contextWindow - reserve - fixed) / 4)),
    );
    // Short originals can cost less than another lookup. Retain them when their
    // complete estimated payload fits a bounded share of the resolved window.
    const retainShortHistory =
      useSnapshots &&
      estimateContextTokens(
        providerContextPrefix("", [], historicalContent),
        options.imageTokens,
      ) <= shortHistoryAllowance;
    if (useSnapshots && !retainShortHistory) {
      const old = historical.slice(0, Math.max(0, historical.length - 8));
      let catalog = "";
      const maximum = Math.min(
        8192,
        Math.max(0, Math.floor((contextWindow - reserve - fixed) / 4)),
      );
      catalogIds = [];
      for (const message of old.slice(-64).reverse()) {
        const stored = original(message);
        if (!stored?.id) continue;
        const entry = `[message ${stored.id}${stored.createdAt ? ` at ${stored.createdAt}` : ""}; ${stored.role}] ${snapshot(stored.content)}\n`;
        if (Buffer.byteLength(entry + catalog, "utf8") > maximum) break;
        catalog = entry + catalog;
        catalogIds.unshift(stored.id);
      }
      const recentStart = Math.max(0, historical.length - 8);
      const earlierSystem = historical
        .slice(0, recentStart)
        .filter((message) => message.role === "system");
      messages = [
        ...earlierSystem,
        ...historical.slice(recentStart),
        ...messages.slice(currentIndex),
      ];
      protectedIndexes = messages.flatMap((message, index) =>
        message.role === "system" ||
        (index >= earlierSystem.length + Math.min(8, historical.length) && message.role === "user")
          ? [index]
          : [],
      );
      if (catalog) {
        const catalogMessage = navigation(catalogIds)!;
        // Include the bounded catalog only if required content leaves room for it.
        const required = protectedIndexes.map((index) => messages[index]!);
        const fixed =
          estimateContextTokens(budget.systemPrompt) + estimateContextTokens(budget.tools);
        if (
          fixed +
            estimateContextTokens(required, options.imageTokens) +
            estimateContextTokens(catalogMessage) <
          contextWindow - reserve
        ) {
          const insertIndex = messages[0]?.role === "system" ? 1 : 0;
          messages.splice(insertIndex, 0, catalogMessage);
          navigationMessage = catalogMessage;
          protectedIndexes = [
            insertIndex,
            ...protectedIndexes.map((index) => index + Number(index >= insertIndex)),
          ];
        }
      }
    }
    const summaries = ctx.messages.filter(
      (message) =>
        (message as Message & OriginalMetadata).rakazoHistory &&
        !(message as Message & OriginalMetadata).rakazoMessageId &&
        (text(message).startsWith("Rakazo-owned compacted context through message sequence ") ||
          text(message).startsWith(
            "Memory recalled from earlier conversations that fell outside the visible history.",
          )),
    );
    for (const summary of summaries) {
      const required = protectedIndexes.map((index) => messages[index]!);
      if (
        fixed +
          estimateContextTokens(required, options.imageTokens) +
          estimateContextTokens(summary, options.imageTokens) >=
        contextWindow - reserve
      )
        continue;
      if (!messages.includes(summary)) {
        const insertIndex = messages[0]?.role === "system" ? 1 : 0;
        messages.splice(insertIndex, 0, summary);
        protectedIndexes = protectedIndexes.map((index) => index + Number(index >= insertIndex));
      }
      protectedIndexes.push(messages.indexOf(summary));
    }
    // Completed loop steps remain useful task state even when their verbose
    // evidence is old. Keep the protocol and controls so dropping large bodies
    // does not make the agent restart work it has already completed.
    const latestToolCall = messages.findLastIndex(
      (message) =>
        message.role === "assistant" && message.content.some((part) => part.type === "toolCall"),
    );
    // Expand the minimum window within three quarters of the input budget,
    // leaving room for conversation as well as the separately reserved output.
    const wholeResultAllowance = Math.max(
      0,
      (contextWindow - reserve - fixed) * (1 - REBUILD_HEADROOM),
    );
    const recentToolResults = new Set<number>();
    let wholeResultTokens = 0;
    const resultIndexes = messages.flatMap((message, index) =>
      message.role === "toolResult" ? [index] : [],
    );
    for (const index of resultIndexes.reverse()) {
      const tokens = estimateContextTokens(
        providerContextPrefix("", [], [messages[index]!]).messages[0],
        options.imageTokens,
      );
      if (
        recentToolResults.size >= RECENT_TOOL_RESULTS_TO_KEEP &&
        wholeResultTokens + tokens > wholeResultAllowance
      )
        break;
      recentToolResults.add(index);
      wholeResultTokens += tokens;
    }
    const shortenOlderResults = (keepRecent: boolean) =>
      messages.map((message, index) => {
        if (
          message.role !== "toolResult" ||
          index >= latestToolCall ||
          (keepRecent && recentToolResults.has(index)) ||
          (message.toolName !== undefined && UNSHORTENED_TOOL_RESULTS.has(message.toolName))
        )
          return message;
        const source = text(message);
        if (source.length <= 1024) return message;
        // The model read this result on an earlier step, so mark it as shortened after use.
        const shortened = shortenToolResultText(
          source,
          1024,
          { name: message.toolName },
          { afterUse: true },
        );
        if (shortened.length >= source.length) return message;
        return {
          ...message,
          content: [
            { type: "text" as const, text: shortened },
            ...message.content.filter((part) => part.type === "image"),
          ],
        };
      });
    const retained = shortenOlderResults(true);
    // Fall back before selection can discard older progress to make room for whole results.
    const retainedTokens = retained.reduce(
      (total, message) =>
        total +
        estimateContextTokens(
          providerContextPrefix("", [], [message]).messages[0],
          options.imageTokens,
        ),
      fixed,
    );
    messages = retainedTokens <= contextWindow - reserve ? retained : shortenOlderResults(false);
    const selected = selectContext(messages, {
      budget,
      strategy,
      protectedIndexes,
      cacheWarmth: predictedCache,
      recentExchanges:
        retainShortHistory || standaloneHistoryFallback ? messages.length : 8 + laterUserMessages,
    });
    const shortenedStructuredResults = selected.messages.filter((message) => {
      if (message.role !== "toolResult") return false;
      try {
        return JSON.parse(text(message))?.contextTruncated === true;
      } catch {
        return false;
      }
    }).length;
    return {
      context: { ...ctx, messages: selected.messages },
      cacheRequest,
      ...(navigationMessage ? { navigation: { message: navigationMessage, catalogIds } } : {}),
      decision: {
        strategy,
        predictedCache,
        estimatedInputTokens: selected.estimatedInputTokens,
        droppedMessages: Math.max(0, ctx.messages.length - selected.messages.length),
        truncatedToolResults: Math.max(selected.truncatedToolResults, shortenedStructuredResults),
        observedReuse: null,
      },
    };
  }
  /** Removes what only a rebuild may drop: stale page state and screenshots over the budget. */
  function pruned(ctx: Context): Context {
    const messages = pruneForRebuild(ctx.messages, request.model.maxImagesPerPrompt);
    return messages === ctx.messages ? ctx : { ...ctx, messages };
  }
  /** Records the context about to be sent for cache prediction and cross-run reuse. */
  function commit(
    context: Context,
    built: Prepared,
    projection: ProjectionEntry[],
    model: Model<Api>,
    fields: Partial<Pick<RuntimeContextDecision, "droppedMessages" | "truncatedToolResults">> = {},
  ): Context {
    const prefix = providerContextPrefix(
      context.systemPrompt ?? "",
      context.tools ?? [],
      context.messages,
    );
    const prefixTokens =
      context === built.context
        ? built.decision.estimatedInputTokens
        : estimateContextTokens(prefix, options.imageTokens);
    pending = { ...built.cacheRequest, prefix, prefixTokens };
    pendingProjection = { scope: projectionScope(model), entries: projection };
    decision = {
      ...built.decision,
      ...fields,
      predictedCache: cache.predict(pending),
      estimatedInputTokens: prefixTokens,
    };
    return context;
  }
  function measure(ctx: Context, messages: Message[]): Size {
    return {
      tokens: estimateContextTokens(
        providerContextPrefix(ctx.systemPrompt ?? "", ctx.tools ?? [], messages),
        options.imageTokens,
      ),
      images: messages.reduce((count, message) => count + imagePartCount(message), 0),
    };
  }
  /** A rebuild that leaves part of the window free, or none when the run needs all of it. */
  function rebuildWithHeadroom(ctx: Context, model: Model<Api>): Prepared | undefined {
    const window = request.model.contextWindow ?? model.contextWindow;
    const reserve = outputReserve(model);
    try {
      return rebuild(ctx, model, reserve + Math.floor((window - reserve) * (1 - REBUILD_HEADROOM)));
    } catch (error) {
      if (error instanceof ContextBudgetError) return undefined;
      throw error;
    }
  }
  function firstChange(before: Message[], after: Message[]): number {
    const length = Math.min(before.length, after.length);
    for (let index = 0; index < length; index++) {
      if (hash(before[index]!) !== hash(after[index]!)) return index;
    }
    return length;
  }
  return {
    /**
     * Each model call in a run gets the transcript the previous call was sent, byte for byte,
     * followed by whatever the run appended since. Rewriting an earlier message breaks the
     * provider's cached prefix and invalidates every later signed thinking block, which
     * providers that bind reasoning to its conversation reject. The context is rebuilt only when
     * that fixes a limit the appended transcript breaks (the model's window or image limit) or
     * when rebuildPaysOff; thinking from the first rewritten message on is then dropped.
     */
    prepareContext(ctx: Context, model: Model<Api>): Context {
      let built = rebuild(ctx, model);
      const head = createHash("sha256")
        .update(JSON.stringify([ctx.systemPrompt ?? "", ctx.tools ?? []]))
        .digest("hex");
      const source = ctx.messages.map(hash);
      const previous = sent;
      const appended =
        previous?.head === head &&
        previous.source.length <= source.length &&
        previous.source.every((value, index) => source[index] === value)
          ? [...previous.messages, ...ctx.messages.slice(previous.source.length)]
          : undefined;
      let append = false;
      if (previous && appended) {
        const available =
          (request.model.contextWindow ?? model.contextWindow) - outputReserve(model);
        const imageLimit = normalizedImageLimit(request.model.maxImagesPerPrompt);
        const overTokens = (size: Size) => size.tokens > available;
        const overImages = (size: Size) => imageLimit !== undefined && size.images > imageLimit;
        const kept = measure(ctx, appended);
        const fresh = measure(ctx, built.context.messages);
        // Each limit is enforced on its own: a rebuild that fixes the image count is still
        // taken when the text stays too large for the window, and the other way round.
        if (overTokens(kept) && !overTokens(fresh))
          built = rebuildWithHeadroom(ctx, model) ?? built;
        else if (!(overImages(kept) && !overImages(fresh)))
          append =
            overTokens(kept) ||
            overImages(kept) ||
            !rebuildPaysOff(kept, fresh, previous.rebuiltTokens, previous.appends);
      }
      if (previous && appended && append) {
        const projection = [
          ...previous.projection,
          ...ctx.messages.slice(previous.source.length).map((message) => ({ hash: hash(message) })),
        ];
        sent = {
          ...previous,
          source,
          messages: appended,
          projection,
          appends: previous.appends + 1,
        };
        return commit({ ...ctx, messages: appended }, built, projection, model, {
          droppedMessages: Math.max(0, ctx.messages.length - appended.length),
          truncatedToolResults: previous.truncatedToolResults,
        });
      }
      const messages = previous
        ? withoutThinkingFrom(
            built.context.messages,
            previous.head === head
              ? firstChange(appended ?? previous.messages, built.context.messages)
              : 0,
          )
        : built.context.messages;
      const projection = messages.map((message) => ({
        hash: hash(message),
        ...(message === built.navigation?.message
          ? { catalogIds: built.navigation.catalogIds }
          : {}),
      }));
      const originalResults = new Map(
        ctx.messages.flatMap((message) =>
          message.role === "toolResult" ? [[message.toolCallId, message] as const] : [],
        ),
      );
      for (const message of messages) {
        if (message.role !== "toolResult") continue;
        const original = originalResults.get(message.toolCallId);
        if (original && text(message).length < text(original).length) {
          shortenedResults.set(hash(original), message);
        }
      }
      sent = {
        head,
        source,
        // A copy, so a caller that later grows the array it passed in cannot change the record.
        messages: [...messages],
        projection,
        truncatedToolResults: built.decision.truncatedToolResults,
        rebuiltTokens: measure(ctx, messages).tokens,
        appends: 0,
      };
      return commit(
        messages === built.context.messages ? built.context : { ...built.context, messages },
        built,
        projection,
        model,
      );
    },
    onUsage(usage: AgentUsage | null | undefined) {
      if (!pending) return;
      const reported =
        usage &&
        [
          usage.inputTokens,
          usage.outputTokens,
          usage.cacheReadTokens,
          usage.cacheWriteTokens,
          usage.totalTokens,
        ].some((value) => typeof value === "number" && Number.isFinite(value));
      if (!reported) {
        pending = undefined;
        pendingProjection = undefined;
        return;
      }
      const observation = cache.record(pending, usage?.cacheReadTokens);
      if (decision) decision.observedReuse = observation.observedReuse;
      pending = undefined;
      if (pendingProjection) {
        projections.delete(pendingProjection.scope);
        projections.set(pendingProjection.scope, pendingProjection.entries);
        while (projections.size > 256) projections.delete(projections.keys().next().value!);
        pendingProjection = undefined;
      }
    },
    getDecision(): RuntimeContextDecision | undefined {
      return decision ? { ...decision } : undefined;
    },
  };
}
