import type { Message } from "@earendil-works/pi-ai";
import { getLogger } from "@rakazo/logging";
import { z } from "zod";
import { withoutSavedMeetingResult } from "../../runs/turn/turn-checkpoint.js";
import { USE_TOOL } from "../../tools/builtin.tool-definition.js";
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
  /** Which message is the person's prompt, and the history message it was sent for. */
  prompt?: { at: number; id: string };
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
  promptId?: string,
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
  const promptAt = start;
  if (start > 0 && isRecall(tagged[start - 1]!)) start -= 1;
  const messages = [...sent.slice(start), reply].map(sentForm);
  const hasImage = messages.some(
    (message) =>
      typeof message.content !== "string" && message.content.some((part) => part.type === "image"),
  );
  if (hasImage) return undefined;
  const transcript: TurnTranscript = {
    version: 1,
    represents: [...represents],
    messages,
    ...(promptId ? { prompt: { at: promptAt - start, id: promptId } } : {}),
  };
  const serialized = JSON.stringify(transcript);
  return serialized.length > MAX_TRANSCRIPT_CHARS ? undefined : serialized;
}

const Parts = z.array(z.object({ type: z.string() }).passthrough());

const StoredTurnSchema = z.object({
  version: z.literal(1),
  represents: z.array(z.string()),
  messages: z
    .array(
      z.union([
        // Only a person's turn can be plain text; the model's and a tool's are lists of parts.
        z.object({ role: z.literal("user"), content: z.union([z.string(), Parts]) }).passthrough(),
        z.object({ role: z.enum(["assistant", "toolResult"]), content: Parts }).passthrough(),
      ]),
    )
    .min(1),
  prompt: z.object({ at: z.number().int().nonnegative(), id: z.string() }).optional(),
});

type StoredTurn = Pick<TurnTranscript, "represents" | "messages" | "prompt">;

/** A stored turn's messages and the history it stands for, or none when it cannot be read. */
export function readTurnTranscript(serialized: string | undefined): StoredTurn | undefined {
  if (!serialized) return undefined;
  let parsed: ReturnType<typeof StoredTurnSchema.safeParse> | undefined;
  try {
    parsed = StoredTurnSchema.safeParse(JSON.parse(serialized));
  } catch {
    parsed = undefined;
  }
  const turn = parsed?.success
    ? {
        represents: parsed.data.represents,
        messages: parsed.data.messages as unknown as Message[],
        ...(parsed.data.prompt ? { prompt: parsed.data.prompt } : {}),
      }
    : undefined;
  // The turn is rebuilt from its reply instead, as before records were kept.
  if (!turn) getLogger().warn("Stored turn transcript could not be read; replaying from the reply");
  return turn;
}

/** Where a text sits in a stored turn, so each can be treated as its kind is elsewhere. */
export type TurnTextKind = "prompt" | "reply" | "arguments" | "result";

/**
 * The stored turn with `change` applied to each text it holds (after `changeArguments` to each
 * call's arguments), or none when it cannot be read or `keep` refuses one of its tool calls.
 */
export function mapTurnTranscript(
  serialized: string,
  change: (text: string, kind: TurnTextKind) => string,
  keep: (toolName: string) => boolean = () => true,
  changeArguments: (args: Record<string, unknown>) => Record<string, unknown> = (args) => args,
): string | undefined {
  const turn = readTurnTranscript(serialized);
  if (!turn) return undefined;
  if (turnToolNames(turn.messages, { reached: true }).some((name) => !keep(name))) return undefined;
  const deep = (value: unknown): unknown =>
    typeof value === "string"
      ? change(value, "arguments")
      : Array.isArray(value)
        ? value.map(deep)
        : value && typeof value === "object"
          ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deep(item)]))
          : value;
  const messages = turn.messages.map((message): Message => {
    const kind: TurnTextKind =
      message.role === "user" ? "prompt" : message.role === "toolResult" ? "result" : "reply";
    if (typeof message.content === "string")
      return { ...message, content: change(message.content, kind) } as Message;
    return {
      ...message,
      content: message.content.map((part) =>
        part.type === "text"
          ? { ...part, text: change(part.text, kind) }
          : part.type === "thinking"
            ? { ...part, thinking: change(part.thinking, kind) }
            : part.type === "toolCall"
              ? {
                  ...part,
                  arguments: deep(changeArguments(part.arguments)) as typeof part.arguments,
                }
              : part,
      ),
    } as Message;
  });
  return JSON.stringify({ ...turn, version: 1, messages });
}

/**
 * Every tool the turn called, by the name the model called it, and with `reached` also each tool
 * it reached through another (use_tool names the one it runs in its arguments).
 */
export function turnToolNames(
  messages: readonly Message[],
  options: { reached?: boolean } = {},
): string[] {
  return messages.flatMap((message) =>
    message.role === "assistant"
      ? message.content.flatMap((part) => {
          if (part.type !== "toolCall") return [];
          const inner = part.arguments?.name;
          return options.reached && part.name === USE_TOOL && typeof inner === "string"
            ? [part.name, inner]
            : [part.name];
        })
      : [],
  );
}

/**
 * The text of every tool result a stored turn hands the model, oldest first, or none when it
 * cannot be read (the turn then replays from its reply).
 */
export function turnTranscriptResults(serialized: string | undefined): string[] | undefined {
  return readTurnTranscript(serialized)?.messages.flatMap((message) =>
    message.role === "toolResult"
      ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
      : [],
  );
}
