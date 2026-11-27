import type { Context, Message } from "@earendil-works/pi-ai";
import { isRecord } from "@rakazo/core";

export type WatchDeliveryState =
  | {
      full: true;
      fullText: string;
      details: Record<string, unknown>;
      toolCallId: string;
      sourceIndex?: number;
      /** Accept sequence of this full delivery, across every watch in the run. */
      order?: number;
    }
  | {
      full: false;
      texts: string[];
      details: Record<string, unknown>;
      toolCallId: string;
      sourceIndex?: number;
      /** Accept sequence of each text, parallel to `texts`. */
      textOrders?: number[];
    };

export interface PendingWatchDelivery {
  key: string;
  state: WatchDeliveryState;
}

function cleanWatchDetails(details: Record<string, unknown>): Record<string, unknown> {
  const { contextBeforeUseText: _beforeUse, contextDeliveredTexts: _delivered, ...clean } = details;
  return clean;
}

function messageText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export function applyWatchDeliveryProvenance(
  ctx: Context,
  messages: Message[],
  sourceIndexes: ReadonlyArray<number | undefined>,
  watchDeliveries: ReadonlyMap<string, WatchDeliveryState> | undefined,
  hash: (message: Message) => string,
): { messages: Message[]; pending: PendingWatchDelivery[] } {
  const pending: PendingWatchDelivery[] = [];
  let changed = false;
  const annotated = messages.map((message, index) => {
    if (message.role !== "toolResult") return message;
    const details = isRecord(message.details) ? message.details : undefined;
    if (!details || !("routines" in details)) return message;
    const sourceIndex = sourceIndexes[index];
    const sourceMessage = sourceIndex !== undefined ? ctx.messages[sourceIndex] : undefined;
    const original = sourceMessage?.role === "toolResult" ? sourceMessage : undefined;
    const key =
      sourceIndex !== undefined
        ? `${sourceIndex}:${hash(original ?? message)}`
        : hash(original ?? message);
    const clean = cleanWatchDetails(details);
    const currentText = messageText(message);
    const originalText = original ? messageText(original) : currentText;
    const existingBeforeUse =
      typeof details.contextBeforeUseText === "string" ? details.contextBeforeUseText : undefined;
    if (currentText.length >= originalText.length && existingBeforeUse === undefined) {
      pending.push({
        key,
        state: {
          full: true,
          fullText: currentText,
          details: clean,
          toolCallId: message.toolCallId,
          ...(sourceIndex !== undefined ? { sourceIndex } : {}),
        },
      });
      return message;
    }
    const prior = watchDeliveries?.get(key);
    if (prior?.full) {
      pending.push({ key, state: prior });
      if (existingBeforeUse === prior.fullText && !("contextDeliveredTexts" in details)) {
        return message;
      }
      changed = true;
      return {
        ...message,
        details: {
          ...clean,
          contextBeforeUseText: prior.fullText,
        },
      };
    }
    const pendingTexts =
      existingBeforeUse !== undefined
        ? currentText !== existingBeforeUse
          ? [existingBeforeUse, currentText]
          : [existingBeforeUse]
        : [currentText];
    pending.push({
      key,
      state: {
        full: false,
        texts: pendingTexts,
        details: clean,
        toolCallId: message.toolCallId,
        ...(sourceIndex !== undefined ? { sourceIndex } : {}),
      },
    });
    if (!prior || prior.texts.length === 0) return message;
    if (existingBeforeUse === undefined) {
      changed = true;
      return {
        ...message,
        details: {
          ...clean,
          contextBeforeUseText: prior.texts[0]!,
          ...(prior.texts.length > 1 ? { contextDeliveredTexts: [...prior.texts] } : {}),
        },
      };
    }
    const extras = prior.texts.filter((entry) => entry !== existingBeforeUse);
    if (extras.length > 0) {
      const currentDelivered = Array.isArray(details.contextDeliveredTexts)
        ? details.contextDeliveredTexts.filter(
            (entry): entry is string => typeof entry === "string",
          )
        : [];
      const merged = [existingBeforeUse, ...extras, ...currentDelivered].filter(
        (entry, itemIndex, list) => list.indexOf(entry) === itemIndex,
      );
      if (
        merged.length !== currentDelivered.length ||
        merged.some((entry, itemIndex) => currentDelivered[itemIndex] !== entry)
      ) {
        changed = true;
        return {
          ...message,
          details: {
            ...clean,
            contextBeforeUseText: existingBeforeUse,
            contextDeliveredTexts: merged,
          },
        };
      }
    }
    return message;
  });
  return { messages: changed ? annotated : messages, pending };
}

function highestDeliveryOrder(watchDeliveries: ReadonlyMap<string, WatchDeliveryState>): number {
  let highest = 0;
  for (const entry of watchDeliveries.values()) {
    if (entry.full) {
      if (entry.order !== undefined && entry.order > highest) highest = entry.order;
    } else {
      for (const order of entry.textOrders ?? []) {
        if (order > highest) highest = order;
      }
    }
  }
  return highest;
}

export function commitWatchDeliveries(
  watchDeliveries: Map<string, WatchDeliveryState> | undefined,
  pending: readonly PendingWatchDelivery[],
): void {
  if (!watchDeliveries || pending.length === 0) return;
  let next = highestDeliveryOrder(watchDeliveries);
  const take = () => {
    next += 1;
    return next;
  };
  for (const { key, state } of pending) {
    if (state.full) {
      const existing = watchDeliveries.get(key);
      // A shortened resend re-queues the full text already accepted for this watch.
      // That text keeps its sequence; only a different full text is a new delivery.
      const recordedOrder =
        existing?.full === true && existing.fullText === state.fullText
          ? existing.order
          : undefined;
      watchDeliveries.set(key, {
        ...state,
        order: recordedOrder !== undefined ? recordedOrder : take(),
      });
      continue;
    }
    const existing = watchDeliveries.get(key);
    if (existing?.full) continue;
    if (!existing) {
      watchDeliveries.set(key, {
        ...state,
        texts: [...state.texts],
        textOrders: state.texts.map(() => take()),
      });
      continue;
    }
    const textOrders =
      existing.textOrders && existing.textOrders.length === existing.texts.length
        ? existing.textOrders
        : existing.texts.map(() => take());
    existing.textOrders = textOrders;
    for (const value of state.texts) {
      if (!existing.texts.includes(value)) {
        existing.texts.push(value);
        textOrders.push(take());
      }
    }
  }
}
