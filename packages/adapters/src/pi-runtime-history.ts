import type { Context, Message } from "@earendil-works/pi-ai";
import type { AgentRunRequest, AgentSteeringMessage } from "@rakazo/adapter-kit";
import { neutralizeSpeakerLabels } from "./history-speakers.js";

export function toPiImages(images: AgentRunRequest["currentTurnImages"]) {
  return (images ?? []).map((image) => ({
    type: "image" as const,
    data: Buffer.from(image.data).toString("base64"),
    mimeType: image.mimeType,
  }));
}

/**
 * Provider, api and model stamped on replayed own replies. None matches a real model, so Pi
 * replays them as plain text from another model: no signatures or reasoning, same on every provider.
 */
const HISTORY_ASSISTANT = { api: "rakazo-history", provider: "rakazo-history", model: "history" };
const NO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
/** Stands in for the opening turn when the window starts on a bot message (Bedrock needs a user first). */
const CONVERSATION_START = "[Conversation start]";

type HistoryMessage = Message & {
  rakazoHistory: true;
  rakazoMessageId?: string;
  rakazoCreatedAt?: string;
};

/** What the model reads for a message by someone other than this bot or the human of a direct chat. */
export function speakerText(speaker: string, text: string): string {
  return `[${speaker}]: ${neutralizeSpeakerLabels(text)}`;
}

/**
 * Replays stored messages with their real roles. This bot's own replies are assistant turns;
 * a message with a `speaker` (another bot, or the human in a group) is a user turn that starts
 * with "[speaker]: ". A system line (a stop or expiry note) is a user turn that starts with
 * "System note: ". These labels exist only here: they are never stored or shown in the app.
 * Content is a pure function of the message, so replayed history is stable for prompt caching.
 */
export function toHistory(
  history: AgentRunRequest["history"],
  prompt: string,
  sourceMessageId?: string | null,
): HistoryMessage[] {
  let duplicatePromptIndex = -1;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (
      message?.role === "user" &&
      (sourceMessageId ? message.id === sourceMessageId : message.content === prompt)
    ) {
      duplicatePromptIndex = index;
      break;
    }
  }
  const prior =
    duplicatePromptIndex < 0
      ? history
      : history.filter((_, index) => index !== duplicatePromptIndex);
  return prior.flatMap((m): HistoryMessage[] => {
    const created = m.createdAt ? Date.parse(m.createdAt) : Number.NaN;
    const common = {
      timestamp: Number.isNaN(created) ? 0 : created,
      rakazoHistory: true as const,
      rakazoMessageId: m.id,
      rakazoCreatedAt: m.createdAt,
    };
    if (m.role === "assistant" && !m.speaker) {
      // A reply whose blocks render to nothing has no text to replay.
      if (!m.content.trim()) return [];
      return [
        {
          role: "assistant" as const,
          content: [{ type: "text" as const, text: m.content }],
          ...HISTORY_ASSISTANT,
          usage: NO_USAGE,
          stopReason: "stop" as const,
          ...common,
        },
      ];
    }
    if (m.role === "system" && !m.content.trim()) return [];
    const text =
      m.role === "system"
        ? `System note: ${neutralizeSpeakerLabels(m.content)}`
        : m.speaker
          ? speakerText(m.speaker, m.content)
          : m.content;
    // Pictures ride on the human's turn only, never on a bot's.
    const images = m.role === "assistant" ? [] : toPiImages(m.images);
    return [
      {
        role: "user" as const,
        content: images.length ? [{ type: "text" as const, text }, ...images] : text,
        ...common,
      },
    ];
  });
}

export function isHistoryReply(message: Message | undefined): boolean {
  return (
    message?.role === "assistant" &&
    Boolean((message as Message & { rakazoHistory?: true }).rakazoHistory)
  );
}

/**
 * Every provider needs the first message to be the user's (Bedrock rejects anything else, and
 * chat templates assume it), but a window or a trim can start on one of this bot's replies.
 * Called on each model call, so it holds whatever the context policy kept.
 */
export function withLeadingUser(context: Context): Context {
  const first = context.messages.findIndex((message) => (message.role as string) !== "system");
  if (first < 0 || context.messages[first]!.role === "user") return context;
  const start: Message = { role: "user", content: CONVERSATION_START, timestamp: 0 };
  return {
    ...context,
    messages: [...context.messages.slice(0, first), start, ...context.messages.slice(first)],
  };
}

export function withoutSteeringMessages(
  history: AgentRunRequest["history"],
  steering: AgentSteeringMessage[],
): AgentRunRequest["history"] {
  if (steering.length === 0) return history;
  const result = [...history];
  let beforeIndex = result.length - 1;
  for (let steeringIndex = steering.length - 1; steeringIndex >= 0; steeringIndex -= 1) {
    const steeringMessage = steering[steeringIndex];
    for (let index = beforeIndex; index >= 0; index -= 1) {
      const message = result[index];
      if (
        message?.role !== "user" ||
        (message.id
          ? message.id !== steeringMessage?.messageId
          : message.content !== (steeringMessage?.historyText ?? steeringMessage?.text))
      ) {
        continue;
      }
      result.splice(index, 1);
      beforeIndex = index - 1;
      break;
    }
  }
  return result;
}
