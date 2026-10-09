import { createHash } from "node:crypto";
import type { AgentContextStrategy, CacheCapabilities } from "@rakazo/adapter-kit";

export type ContextStrategy = AgentContextStrategy;
export interface ContextMessage {
  role: string;
  content?: unknown;
  toolCallId?: string;
  toolName?: string;
  sections?: Record<string, string | null>;
  toolsAdded?: unknown;
  toolsRemoved?: unknown;
}
export interface ContextBudget {
  contextWindow: number;
  outputReserve: number;
  systemPrompt: string;
  tools: unknown;
  /** Additional instructions, snapshots, retrieved passages or task state outside messages. */
  extraContext?: string;
  /** Adapter-specific image planning estimate. Unknown images use serialized bytes. */
  imageTokens?: number | ((image: object) => number | undefined);
}
export interface ContextSelectionOptions {
  budget: ContextBudget;
  strategy: ContextStrategy;
  /** Never drop current request, steering, approvals or authoritative constraints. */
  protectedIndexes?: readonly number[];
  recentExchanges?: number;
  cacheWarmth?: "likely-warm" | "likely-cold" | "unknown";
  /** Keep tool protocol intact while shortening oversized result bodies. */
  truncateToolResults?: boolean;
}
export class ContextBudgetError extends Error {
  constructor(
    public readonly estimatedTokens: number,
    public readonly availableTokens: number,
  ) {
    super("Required context exceeds the model context budget");
    this.name = "ContextBudgetError";
  }
}
function imageBlocks(value: unknown): object[] {
  const found: object[] = [];
  const visitMessage = (message: unknown) => {
    if (!message || typeof message !== "object") return;
    if (
      "role" in message &&
      (message.role === "user" || message.role === "toolResult") &&
      "content" in message &&
      Array.isArray(message.content)
    ) {
      for (const part of message.content) {
        if (part && typeof part === "object" && "type" in part && part.type === "image")
          found.push(part);
      }
    }
  };
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item && typeof item === "object" && "type" in item && item.type === "image")
        found.push(item);
      else visitMessage(item);
    }
  } else if (
    value &&
    typeof value === "object" &&
    "messages" in value &&
    Array.isArray(value.messages)
  ) {
    for (const message of value.messages) visitMessage(message);
  } else visitMessage(value);
  return found;
}
/** Conservative byte bound plus framing, not a tokenizer. Only actual user/tool
 * image blocks receive an adapter estimate; image-shaped tool arguments remain text.
 */
export function estimateContextTokens(
  value: unknown,
  imageTokens?: ContextBudget["imageTokens"],
): number {
  const images = new Set<object>();
  let imageTotal = 0;
  if (imageTokens !== undefined) {
    for (const image of imageBlocks(value)) {
      const estimate = typeof imageTokens === "number" ? imageTokens : imageTokens(image);
      if (estimate !== undefined && Number.isFinite(estimate) && estimate > 0) {
        images.add(image);
        imageTotal += estimate;
      }
    }
  }
  const serialized =
    JSON.stringify(value, (_key, item: unknown) =>
      item && typeof item === "object" && images.has(item) ? { type: "image" } : item,
    ) ?? "";
  return Buffer.byteLength(serialized, "utf8") + imageTotal + 16;
}
function fixedTokens(budget: ContextBudget): number {
  for (const value of [
    budget.contextWindow,
    budget.outputReserve,
    typeof budget.imageTokens === "number" ? budget.imageTokens : 0,
  ]) {
    if (!Number.isFinite(value) || value < 0) throw new Error("Invalid context budget");
  }
  if (typeof budget.imageTokens === "number" && budget.imageTokens < 1)
    throw new Error("Invalid image token bound");
  return (
    estimateContextTokens(budget.systemPrompt) +
    estimateContextTokens(budget.tools) +
    (budget.extraContext ? estimateContextTokens(budget.extraContext) : 0)
  );
}
interface HistoryTextReference {
  text: string;
  textOffset: number;
  nextTextOffset: number | null;
  truncated: boolean;
}
function shortenHistoryResult(
  content: unknown,
  size: number,
  tool: { name?: string; arguments?: unknown },
): string | undefined {
  if (tool.name !== "read_history" && tool.name !== "search_history") return;
  const source =
    typeof content === "string"
      ? content
      : Array.isArray(content) && content.length === 1 && content[0]?.type === "text"
        ? content[0].text
        : undefined;
  if (typeof source !== "string") return;
  let payload: {
    untrusted?: boolean;
    messages: HistoryTextReference[];
    runs?: Array<{ outcomes?: HistoryTextReference[] }>;
    snapshots?: Array<{ topic?: string; outcome?: string }>;
    contextTruncated?: boolean;
  };
  try {
    payload = JSON.parse(source);
  } catch {
    return;
  }
  if (payload?.untrusted !== true || !Array.isArray(payload.messages)) return;
  const refs: HistoryTextReference[] = [
    ...payload.messages,
    ...(Array.isArray(payload.runs)
      ? payload.runs.flatMap((run) => (Array.isArray(run?.outcomes) ? run.outcomes : []))
      : []),
  ].filter((ref) => typeof ref?.text === "string" && Number.isInteger(ref.textOffset));
  // Snapshot text is only navigation; original reference offsets retain exact evidence.
  for (const snapshot of Array.isArray(payload.snapshots) ? payload.snapshots : []) {
    if (!snapshot || typeof snapshot !== "object") continue;
    if (typeof snapshot.topic === "string") snapshot.topic = snapshot.topic.slice(0, 80);
    if (typeof snapshot.outcome === "string") snapshot.outcome = snapshot.outcome.slice(0, 80);
  }
  payload.contextTruncated = true;
  let encoded = JSON.stringify(payload);
  while (encoded.length > size) {
    const longest = refs.reduce<HistoryTextReference | undefined>(
      (best, ref) => (!best || ref.text.length > best.text.length ? ref : best),
      undefined,
    );
    if (!longest || longest.text.length < 2) {
      return JSON.stringify({
        untrusted: true,
        contextTruncated: true,
        needsRetry: true,
        error:
          "History metadata does not fit. Retry the same request with limit 1; no evidence or paging cursor was consumed.",
        retry: {
          ...(tool.arguments && typeof tool.arguments === "object" ? tool.arguments : {}),
          limit: 1,
        },
      });
    }
    longest.text = longest.text.slice(0, Math.floor(longest.text.length / 2));
    longest.nextTextOffset = longest.textOffset + longest.text.length;
    longest.truncated = true;
    encoded = JSON.stringify(payload);
  }
  return encoded;
}
/** Keep control fields and JSON shape while marking omitted long evidence strings. */
function shortenStructuredResult(source: string, size: number): string | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(source);
  } catch {
    return;
  }
  const holder: Record<string, unknown> = { payload };
  const leaves: Array<{ parent: Record<string, unknown> | unknown[]; key: string | number }> = [];
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      // IDs, cursors and routing/action metadata must remain usable exactly as returned.
      if (
        typeof child === "string" &&
        !/(?:id|cursor|token|url|path|name|status|type|query)$/i.test(key)
      )
        leaves.push({ parent: value as Record<string, unknown>, key });
      else if (child && typeof child === "object") visit(child);
    }
  };
  if (typeof payload === "string") leaves.push({ parent: holder, key: "payload" });
  else visit(payload);
  if (payload && typeof payload === "object" && !Array.isArray(payload))
    (payload as Record<string, unknown>).contextTruncated = true;
  let encoded = JSON.stringify(holder.payload);
  while (encoded.length > size) {
    const largest = leaves.reduce<(typeof leaves)[number] | undefined>((best, leaf) => {
      const value = (leaf.parent as Record<string, unknown>)[leaf.key];
      const prior = best ? (best.parent as Record<string, unknown>)[best.key] : undefined;
      return typeof value === "string" &&
        value.length > 128 &&
        (!best || typeof prior !== "string" || value.length > prior.length)
        ? leaf
        : best;
    }, undefined);
    if (!largest) break; // Required metadata alone may still need explicit budget failure.
    const value = (largest.parent as Record<string, unknown>)[largest.key] as string;
    const keep = Math.max(8, Math.floor(value.length / 4));
    const shortened = `${value.slice(0, keep)}\n[Tool result truncated to fit context; omitted evidence is unavailable.]\n${value.slice(-keep)}`;
    if (shortened.length >= value.length) break;
    (largest.parent as Record<string, unknown>)[largest.key] = shortened;
    encoded = JSON.stringify(holder.payload);
  }
  return encoded;
}

/** Shorten evidence cheaply while keeping structured controls and original-history offsets. */
export function shortenToolResultText(
  source: string,
  size: number,
  tool: { name?: string; arguments?: unknown } = {},
): string {
  return (
    shortenHistoryResult(source, size, tool) ??
    shortenStructuredResult(source, size) ??
    `${source.slice(0, Math.floor(size / 2))}\n[Tool result truncated to fit context; inspect original evidence before claiming omitted details.]\n${source.slice(-Math.floor(size / 2))}`
  );
}
interface Group {
  indexes: number[];
  tokens: number;
}
/** A tool request and all results form an indivisible group. User exchanges may contain several groups. */
function messageGroups(
  messages: readonly ContextMessage[],
  imageTokens?: ContextBudget["imageTokens"],
): Group[] {
  const groups: Group[] = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    if (message.role === "toolResult") {
      const group = groups.at(-1);
      if (!group?.indexes.some((i) => messages[i]!.role === "assistant")) {
        throw new Error("Orphaned tool result in context");
      }
      const assistant = messages[group.indexes[0]!]!;
      const calls = Array.isArray(assistant.content)
        ? assistant.content.filter(
            (item) =>
              item && typeof item === "object" && "type" in item && item.type === "toolCall",
          )
        : [];
      if (!message.toolCallId || !calls.some((call) => call.id === message.toolCallId)) {
        throw new Error("Unmatched tool result in context");
      }
      if (
        group.indexes.some(
          (previous) =>
            messages[previous]!.role === "toolResult" &&
            messages[previous]!.toolCallId === message.toolCallId,
        )
      )
        throw new Error("Duplicate tool result in context");
      group.indexes.push(index);
      group.tokens += estimateContextTokens(
        providerContextPrefix("", [], [message]).messages[0],
        imageTokens,
      );
    } else {
      groups.push({
        indexes: [index],
        tokens: estimateContextTokens(
          providerContextPrefix("", [], [message]).messages[0],
          imageTokens,
        ),
      });
    }
  }
  for (const group of groups) {
    if (messages[group.indexes[0]!]!.role !== "assistant") continue;
    const content = messages[group.indexes[0]!]!.content;
    if (!Array.isArray(content)) continue;
    for (const call of content) {
      if (
        call &&
        typeof call === "object" &&
        "type" in call &&
        call.type === "toolCall" &&
        !group.indexes.some((index) => messages[index]!.toolCallId === call.id)
      ) {
        throw new Error("Missing tool result in context");
      }
    }
  }
  return groups;
}
/** Cheap selection only. No clock event or strategy calls a model or creates a summary. */
export function selectContext<T extends ContextMessage>(
  messages: readonly T[],
  options: ContextSelectionOptions,
): {
  messages: T[];
  estimatedInputTokens: number;
  droppedMessages: number;
  truncatedToolResults: number;
  availableMessageTokens: number;
  estimation: "utf8-byte-bound";
} {
  const fixed = fixedTokens(options.budget);
  const available = Math.floor(options.budget.contextWindow - options.budget.outputReserve - fixed);
  const groups = messageGroups(messages, options.budget.imageTokens);
  const protectedIndexes = new Set(options.protectedIndexes ?? []);
  for (const [index, message] of messages.entries()) {
    if (message.role === "system") protectedIndexes.add(index);
  }
  const lastUser = messages.findLastIndex((message) => message.role === "user");
  if (lastUser >= 0) protectedIndexes.add(lastUser);
  // Keep the latest tool group intact. Earlier complete groups can be omitted.
  for (const index of groups.at(-1)?.indexes ?? []) protectedIndexes.add(index);
  for (const index of protectedIndexes) {
    if (!Number.isInteger(index) || index < 0 || index >= messages.length)
      throw new Error("Invalid protected context index");
  }
  const protectedGroupIndexes = new Set<number>();
  const selected = new Set<Group>();
  let used = 0;
  for (const group of groups) {
    if (group.indexes.some((index) => protectedIndexes.has(index))) {
      selected.add(group);
      for (const index of group.indexes) protectedGroupIndexes.add(index);
      used += group.tokens;
    }
  }
  if (used > available) {
    if (options.truncateToolResults !== false) {
      let shortenedCount = 0;
      const shortened = messages.map((message, index) => {
        if (!protectedGroupIndexes.has(index) || message.role !== "toolResult") return message;
        const parts = Array.isArray(message.content) ? message.content : undefined;
        const images =
          parts?.filter((part) => part && typeof part === "object" && part.type === "image") ?? [];
        const serialized = parts?.every(
          (part) =>
            part && typeof part === "object" && (part.type === "text" || part.type === "image"),
        )
          ? parts
              .filter((part) => part.type === "text" && typeof part.text === "string")
              .map((part) => part.text)
              .join("\n")
          : typeof message.content === "string"
            ? message.content
            : JSON.stringify(message.content);
        if (!serialized || serialized.length <= 256) return message;
        const size = Math.max(
          128,
          Math.min(Math.floor(serialized.length / 2), Math.floor(available / 4)),
        );
        const group = groups.find((group) => group.indexes.includes(index));
        const assistant = group ? messages[group.indexes[0]!] : undefined;
        const nativeCall = Array.isArray(assistant?.content)
          ? assistant.content.find(
              (part) => part?.type === "toolCall" && part.id === message.toolCallId,
            )
          : undefined;
        const text = shortenToolResultText(
          serialized,
          size,
          nativeCall ?? { name: message.toolName },
        );
        if (text.length >= serialized.length) return message;
        shortenedCount += 1;
        return { ...message, content: [{ type: "text", text }, ...images] } as T;
      });
      if (shortenedCount) {
        const retry = selectContext(shortened, options);
        return {
          ...retry,
          truncatedToolResults: Math.max(retry.truncatedToolResults, shortenedCount),
        };
      }
    }
    throw new ContextBudgetError(
      used + fixed,
      options.budget.contextWindow - options.budget.outputReserve,
    );
  }
  const keepPrefix =
    options.strategy === "current" ||
    (options.strategy === "cache-aware" && options.cacheWarmth === "likely-warm");
  const exchangeLimit = keepPrefix
    ? Number.POSITIVE_INFINITY
    : Math.max(1, options.recentExchanges ?? 8);
  let exchanges = 0;
  // Retain a contiguous recent suffix. Skip no holes inside a retained tool group.
  for (let index = groups.length - 1; index >= 0; index--) {
    const group = groups[index]!;
    if (group.indexes.some((i) => messages[i]!.role === "user")) exchanges += 1;
    if (exchanges > exchangeLimit && !selected.has(group)) break;
    if (selected.has(group)) continue;
    if (used + group.tokens > available) break;
    selected.add(group);
    used += group.tokens;
  }
  const selectedIndexes = new Set([...selected].flatMap((group) => group.indexes));
  return {
    messages: messages.filter((_message, index) => selectedIndexes.has(index)),
    estimatedInputTokens: fixed + used,
    droppedMessages: messages.length - selectedIndexes.size,
    truncatedToolResults: 0,
    availableMessageTokens: available,
    estimation: "utf8-byte-bound" as const,
  };
}

export interface CacheRequest {
  /** Opaque server-side scope including provider account/routing identity. Never sent in prompts. */
  accountScope: string;
  connectionId: string;
  modelId: string;
  prefix: unknown;
  prefixTokens: number;
  capabilities?: CacheCapabilities;
  /** Tracker-clock request start, kept outside the provider payload and prefix identity. */
  startedAt?: number;
}
export function providerContextPrefix<T extends ContextMessage>(
  systemPrompt: string,
  tools: unknown,
  messages: readonly T[],
) {
  return {
    systemPrompt,
    tools,
    messages: messages.map((message) => ({
      role: message.role,
      content: message.content,
      ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
      ...(message.toolName ? { toolName: message.toolName } : {}),
      ...(message.sections ? { sections: message.sections } : {}),
      ...(message.toolsAdded ? { toolsAdded: message.toolsAdded } : {}),
      ...(message.toolsRemoved ? { toolsRemoved: message.toolsRemoved } : {}),
    })),
  };
}
interface CacheEntry {
  at: number;
}
/** Bounded in-memory metadata only. Store hashes, never instruction text or credentials. */
export class ContextCacheTracker {
  private readonly entries = new Map<string, CacheEntry>();
  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxEntries = 256,
  ) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1)
      throw new Error("Invalid cache metadata limit");
  }
  private key(request: CacheRequest, prefix = request.prefix): string {
    return createHash("sha256")
      .update(
        JSON.stringify([
          request.accountScope,
          request.connectionId,
          request.modelId,
          request.capabilities?.retentionMode,
          prefix,
        ]),
      )
      .digest("hex");
  }
  private matchingEntry(request: CacheRequest): CacheEntry | undefined {
    const direct = this.entries.get(this.key(request));
    if (direct) return direct;
    const prefix = request.prefix;
    if (
      !prefix ||
      typeof prefix !== "object" ||
      !("messages" in prefix) ||
      !Array.isArray(prefix.messages)
    )
      return;
    // Exact previously requested prefix may be followed by new exchanges. Hash only;
    // ignore transient Pi timestamps through providerContextPrefix at the caller.
    for (
      let count = prefix.messages.length - 1;
      count >= Math.max(0, prefix.messages.length - 256);
      count--
    ) {
      const candidate = { ...prefix, messages: prefix.messages.slice(0, count) };
      const entry = this.entries.get(this.key(request, candidate));
      if (entry) return entry;
    }
    return;
  }
  predict(request: CacheRequest): "likely-warm" | "likely-cold" | "unknown" {
    if (request.capabilities?.retentionMode === "none") return "likely-cold";
    const retention = request.capabilities?.retentionMs;
    if (!retention || retention <= 0 || !Number.isFinite(retention)) return "unknown";
    if (request.prefixTokens < (request.capabilities?.minimumTokens ?? 0)) return "likely-cold";
    const entry = this.matchingEntry(request);
    if (!entry) return "likely-cold";
    return this.now() - entry.at < retention ? "likely-warm" : "likely-cold";
  }
  stamp(request: CacheRequest): CacheRequest {
    return { ...request, startedAt: this.now() };
  }
  /** Record actual matching requests, including background calls. Cache reads confirm, zero disproves reuse. */
  record(request: CacheRequest, observedCacheReadTokens?: number | null) {
    const key = this.key(request);
    const startedAt = request.startedAt;
    const at = typeof startedAt === "number" && Number.isFinite(startedAt) ? startedAt : this.now();
    const previousAt = this.entries.get(key)?.at;
    this.entries.delete(key);
    this.entries.set(key, {
      at: previousAt === undefined ? at : Math.max(previousAt, at),
    });
    while (this.entries.size > this.maxEntries)
      this.entries.delete(this.entries.keys().next().value!);
    return { observedReuse: observedCacheReadTokens == null ? null : observedCacheReadTokens > 0 };
  }
}
