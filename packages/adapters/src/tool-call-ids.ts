import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";

/** Tool call ids already in a transcript, to seed a run's set of used ids. */
export function toolCallIdsIn(messages: readonly Message[]): Set<string> {
  return new Set(
    messages.flatMap((message) =>
      message.role === "assistant"
        ? message.content.flatMap((part) => (part.type === "toolCall" ? [part.id] : []))
        : [],
    ),
  );
}

/**
 * Some providers number tool calls per reply (call_0, call_1, ...) or leave the id out. Results,
 * context selection and the next request all pair a result with its call by id, so a repeated or
 * empty id attaches results to the wrong call. Renames such calls to an id unused in the run.
 */
export function withUniqueToolCallIds(
  message: AssistantMessage,
  used: Set<string>,
): AssistantMessage {
  let changed = false;
  const content = message.content.map((part) => {
    if (part.type !== "toolCall") return part;
    if (part.id && !used.has(part.id)) {
      used.add(part.id);
      return part;
    }
    const base = part.id || "call";
    let suffix = 1;
    while (used.has(`${base}_${suffix}`)) suffix++;
    const id = `${base}_${suffix}`;
    used.add(id);
    changed = true;
    return { ...part, id };
  });
  return changed ? { ...message, content } : message;
}

/** The model's stream with each completed reply's tool call ids made unique within the run. */
export function uniqueToolCallIdStream(
  source: AssistantMessageEventStream,
  used: Set<string>,
): AssistantMessageEventStream {
  const output = new AssistantMessageEventStream();
  void (async () => {
    let finished = false;
    for await (const event of source) {
      if (event.type === "done") {
        finished = true;
        output.push({ ...event, message: withUniqueToolCallIds(event.message, used) });
      } else {
        if (event.type === "error") finished = true;
        output.push(event);
      }
    }
    output.end(finished ? undefined : withUniqueToolCallIds(await source.result(), used));
  })();
  return output;
}
