import { createHash, randomBytes } from "node:crypto";
import type { Api, Context, Message, Model } from "@earendil-works/pi-ai";
import type { AdapterContext, AgentRunRequest, AgentUsage } from "@rakazo/adapter-kit";
import { DEFAULT_CONTEXT_STRATEGY } from "@rakazo/adapter-kit";
import type { CacheRequest, ContextBudget } from "./context-selection.js";
import {
  ContextCacheTracker,
  estimateContextTokens,
  providerContextPrefix,
  selectContext,
  shortenToolResultText,
} from "./context-selection.js";

const accountSalt = randomBytes(32);
const sharedCacheTracker = new ContextCacheTracker();
interface ProjectionEntry {
  hash: string;
  catalogIds?: string[];
}
const projections = new Map<string, ProjectionEntry[]>();
const messageHash = (message: Message) =>
  createHash("sha256")
    .update(JSON.stringify(providerContextPrefix("", [], [message])))
    .digest("hex");
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
  return {
    prepareContext(ctx: Context, model: Model<Api>): Context {
      const strategy = request.contextStrategy ?? DEFAULT_CONTEXT_STRATEGY;
      const standaloneHistoryFallback =
        request.contextStrategy === undefined &&
        (!request.executeTool ||
          !["read_history", "search_history"].every((name) =>
            request.tools.some((tool) => tool.name === name),
          ));
      metadataPresent = ctx.messages.some((message) =>
        Boolean((message as Message & OriginalMetadata).rakazoHistory),
      );
      const fullPrefix = providerContextPrefix(
        ctx.systemPrompt ?? "",
        ctx.tools ?? [],
        ctx.messages,
      );
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
        pending = cacheRequest;
        pendingProjection = {
          scope: projectionScope(model),
          entries: ctx.messages.map((message) => ({ hash: messageHash(message) })),
        };
        decision = {
          strategy,
          predictedCache,
          estimatedInputTokens: cacheRequest.prefixTokens,
          droppedMessages: 0,
          truncatedToolResults: 0,
          observedReuse: null,
        };
        return ctx;
      }
      // Metadata distinguishes repeated historical requests from the live request.
      let messages = projected?.messages ?? [...ctx.messages];
      let currentIndex = messages.findIndex(
        (message) =>
          message.role === "user" && message !== projected?.navigation && !original(message),
      );
      if (currentIndex < 0)
        currentIndex = messages.findLastIndex((message) => message.role === "user");
      if (currentIndex < 0) currentIndex = 0;
      let protectedIndexes = messages.flatMap((message, index) =>
        message.role === "system" || (index >= currentIndex && message.role === "user")
          ? [index]
          : [],
      );
      const modelWindow = request.model.contextWindow ?? model.contextWindow;
      const outputReserve = request.model.maxTokens ?? model.maxTokens;
      const fixed =
        estimateContextTokens(ctx.systemPrompt ?? "") + estimateContextTokens(ctx.tools ?? []);
      // Recent history and navigation have their own bounds. Active tool progress
      // uses the actual model budget rather than an artificial smaller window.
      const contextWindow = modelWindow;
      let navigationMessage = projected?.navigation;
      let catalogIds = projected?.catalogIds ?? [];
      const budget = {
        contextWindow,
        outputReserve,
        systemPrompt: ctx.systemPrompt ?? "",
        tools: ctx.tools ?? [],
        imageTokens: options.imageTokens,
      };
      const useSnapshots =
        strategy === "snapshots" ||
        (strategy === "cache-aware" && predictedCache !== "likely-warm");
      const historical = messages.slice(0, currentIndex);
      const historicalContent = historical.filter((message) => message.role !== "system");
      const shortHistoryAllowance = Math.min(
        16384,
        Math.max(0, Math.floor((contextWindow - outputReserve - fixed) / 4)),
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
          Math.max(0, Math.floor((contextWindow - outputReserve - fixed) / 4)),
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
          (index >= earlierSystem.length + Math.min(8, historical.length) &&
            message.role === "user")
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
            contextWindow - outputReserve
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
          contextWindow - outputReserve
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
      messages = messages.map((message, index) => {
        if (
          message.role !== "toolResult" ||
          index >= latestToolCall ||
          message.toolName === "read_history" ||
          message.toolName === "search_history"
        )
          return message;
        const source = text(message);
        if (source.length <= 1024) return message;
        const shortened = shortenToolResultText(source, 1024, { name: message.toolName });
        if (shortened.length >= source.length) return message;
        return {
          ...message,
          content: [
            { type: "text" as const, text: shortened },
            ...message.content.filter((part) => part.type === "image"),
          ],
        };
      });
      const selected = selectContext(messages, {
        budget,
        strategy,
        protectedIndexes,
        cacheWarmth: predictedCache,
        recentExchanges: retainShortHistory || standaloneHistoryFallback ? messages.length : 8,
      });
      const shortenedStructuredResults = selected.messages.filter((message) => {
        if (message.role !== "toolResult") return false;
        try {
          return JSON.parse(text(message))?.contextTruncated === true;
        } catch {
          return false;
        }
      }).length;
      const prepared = { ...ctx, messages: selected.messages };
      pending = {
        ...cacheRequest,
        prefix: providerContextPrefix(
          prepared.systemPrompt ?? "",
          prepared.tools ?? [],
          prepared.messages,
        ),
        prefixTokens: selected.estimatedInputTokens,
      };
      pendingProjection = {
        scope: projectionScope(model),
        entries: selected.messages.map((message) => ({
          hash: messageHash(message),
          ...(message === navigationMessage ? { catalogIds } : {}),
        })),
      };
      decision = {
        strategy,
        predictedCache: cache.predict(pending),
        estimatedInputTokens: selected.estimatedInputTokens,
        droppedMessages: Math.max(0, ctx.messages.length - selected.messages.length),
        truncatedToolResults: Math.max(selected.truncatedToolResults, shortenedStructuredResults),
        observedReuse: null,
      };
      return prepared;
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
