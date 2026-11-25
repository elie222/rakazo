import type { Message } from "@earendil-works/pi-ai";
import { withoutSavedMeetingResult } from "../../runs/turn/turn-checkpoint.js";
import { RECALLED_MEMORY_LEAD } from "../context/runtime-context.prompt.js";

/**
 * A finished turn as its last request sent it, and the reply, stored with that reply. The bot's
 * next turn replays these messages instead of rebuilding them from the stored reply, so its
 * request starts with the earlier request byte for byte and the provider reuses it from cache.
 */
interface TurnTranscript {
  version: 1;
  /** The history messages the turn stands for: its prompt and steering it took up. */
  represents: string[];
  messages: Message[];
}

/** Larger turns are replayed from the stored reply instead; history is read on every run. */
const MAX_TRANSCRIPT_CHARS = 256_000;

type Tagged = Message & { rakazoHistory?: true; rakazoMessageId?: string };

function isRecall(message: Tagged): boolean {
  const content = message.content;
  const text =
    typeof content === "string"
      ? content
      : (content.find((part) => part.type === "text")?.text ?? "");
  return (
    message.role === "user" &&
    Boolean(message.rakazoHistory) &&
    !message.rakazoMessageId &&
    text.startsWith(`${RECALLED_MEMORY_LEAD} `)
  );
}

/** What the provider sees of a message: no Rakazo tags, and no tool details it is never sent. */
function sentForm(message: Message): Message {
  const { rakazoHistory, rakazoMessageId, rakazoCreatedAt, ...rest } = message as Tagged & {
    rakazoCreatedAt?: string;
  };
  void rakazoHistory;
  void rakazoMessageId;
  void rakazoCreatedAt;
  const kept = withoutSavedMeetingResult(rest as Message);
  if (kept.role !== "toolResult") return kept;
  const { details, ...result } = kept as Message & { details?: unknown };
  void details;
  return result as Message;
}

/**
 * The turn from its first message after the stored history (recalled memory, then the prompt) to
 * the reply. None when the turn did not end in a plain reply, or holds images, which are stored
 * apart from messages and replayed from there.
 */
export function captureTurnTranscript(
  sent: readonly Message[] | undefined,
  reply: Message | undefined,
  represents: readonly string[],
): string | undefined {
  if (!sent || reply?.role !== "assistant" || reply.stopReason !== "stop") return undefined;
  if (reply.content.some((part) => part.type === "toolCall")) return undefined;
  if (!reply.content.some((part) => part.type === "text" && part.text.trim())) return undefined;
  const tagged = sent as readonly Tagged[];
  const lastHistory = tagged.findLastIndex((message) => Boolean(message.rakazoMessageId));
  // The instructions lead every request on their own; the turn starts after them.
  let start = tagged.findIndex(
    (message, index) =>
      index > lastHistory && !message.rakazoHistory && (message.role as string) !== "system",
  );
  if (start < 0) return undefined;
  if (start > 0 && isRecall(tagged[start - 1]!)) start -= 1;
  const messages = [...sent.slice(start), reply].map(sentForm);
  const hasImage = messages.some(
    (message) =>
      typeof message.content !== "string" && message.content.some((part) => part.type === "image"),
  );
  if (hasImage) return undefined;
  const transcript: TurnTranscript = { version: 1, represents: [...represents], messages };
  const serialized = JSON.stringify(transcript);
  return serialized.length > MAX_TRANSCRIPT_CHARS ? undefined : serialized;
}

/** A stored turn's messages and the history it stands for, or none when it cannot be read. */
export function readTurnTranscript(
  serialized: string | undefined,
): Pick<TurnTranscript, "represents" | "messages"> | undefined {
  if (!serialized) return undefined;
  try {
    const value = JSON.parse(serialized) as Partial<TurnTranscript>;
    if (
      value.version !== 1 ||
      !Array.isArray(value.represents) ||
      !value.represents.every((id) => typeof id === "string") ||
      !Array.isArray(value.messages) ||
      value.messages.length === 0 ||
      !value.messages.every(
        (message) =>
          message &&
          typeof message === "object" &&
          ["user", "assistant", "toolResult"].includes(message.role) &&
          (typeof message.content === "string" || Array.isArray(message.content)),
      )
    )
      return undefined;
    return { represents: value.represents, messages: value.messages };
  } catch {
    return undefined;
  }
}
