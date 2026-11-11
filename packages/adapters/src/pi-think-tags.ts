import type {
  AssistantMessage,
  AssistantMessageEvent,
  TextContent,
  ThinkingContent,
} from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";

const OPEN = "<think>";
const CLOSE = "</think>";

type Split = {
  /** The thoughts read so far; undefined when the text does not open with a think block. */
  thinking?: string;
  closed: boolean;
  /** The answer after the block, or the whole text when there is none. */
  text: string;
  /** Too little text to tell yet whether it opens with a think block. */
  pending: boolean;
};

function splitLeadingThink(raw: string, final: boolean): Split {
  const start = raw.trimStart();
  if (!start.startsWith(OPEN)) {
    const pending = !final && OPEN.startsWith(start);
    return { closed: false, text: pending ? "" : raw, pending };
  }
  const body = start.slice(OPEN.length).trimStart();
  const end = body.indexOf(CLOSE);
  if (end !== -1) {
    return {
      thinking: body.slice(0, end),
      closed: true,
      text: body.slice(end + CLOSE.length).trimStart(),
      pending: false,
    };
  }
  // Keep back a tail that may be the start of the closing tag, so thoughts only ever grow.
  let held = final ? 0 : Math.min(CLOSE.length - 1, body.length);
  while (held > 0 && !CLOSE.startsWith(body.slice(body.length - held))) held -= 1;
  return {
    thinking: body.slice(0, body.length - held),
    closed: false,
    text: "",
    pending: false,
  };
}

type Rewritten = { message: AssistantMessage; index: number; split: Split };

/** The message with its first text block's leading think block as a thinking block, if it has one. */
function rewriteMessage(message: AssistantMessage, final: boolean): Rewritten | undefined {
  const index = message.content.findIndex((block) => block.type === "text");
  if (index === -1) return undefined;
  const block = message.content[index] as TextContent;
  const split = splitLeadingThink(block.text, final);
  if (split.thinking === undefined && !split.pending) return undefined;
  const thinking: ThinkingContent[] =
    split.thinking === undefined ? [] : [{ type: "thinking", thinking: split.thinking }];
  const text: TextContent[] =
    split.text || split.thinking === undefined ? [{ ...block, text: split.text }] : [];
  return {
    message: {
      ...message,
      content: [
        ...message.content.slice(0, index),
        ...thinking,
        ...text,
        ...message.content.slice(index + 1),
      ],
    },
    index,
    split,
  };
}

/**
 * Some local and compatible servers put a reasoning model's thoughts at the start of the answer
 * text as `<think>…</think>` instead of in a reasoning field. This reports that leading block as
 * thinking, the way a reasoning field is reported, so the thoughts are not shown as the answer
 * and are not sent back to the model on later steps. Text that opens any other way is untouched.
 */
export function splitLeadingThinkBlock(
  stream: AssistantMessageEventStream,
): AssistantMessageEventStream {
  class SplitStream extends AssistantMessageEventStream {
    override async *[Symbol.asyncIterator](): AsyncGenerator<AssistantMessageEvent> {
      let plain = false;
      let textEnded = false;
      let heldTextStart = false;
      let thinkingStarted = false;
      let thinkingEnded = false;
      let thinkingSent = 0;
      let textStarted = false;
      let textSent = 0;
      for await (const event of stream) {
        if (plain) {
          yield event;
          continue;
        }
        if (event.type === "done" || event.type === "error") {
          const message = event.type === "done" ? event.message : event.error;
          const rewritten = rewriteMessage(message, true)?.message;
          if (!rewritten) yield event;
          else if (event.type === "done") yield { ...event, message: rewritten };
          else yield { ...event, error: rewritten };
          continue;
        }
        const ownIndex = event.partial.content.findIndex((block) => block.type === "text");
        const own = ownIndex !== -1 && "contentIndex" in event && event.contentIndex === ownIndex;
        if (own && event.type === "text_end") textEnded = true;
        const rewritten = rewriteMessage(event.partial, textEnded);
        if (!rewritten) {
          if (ownIndex === -1) {
            yield event;
            continue;
          }
          // The first text block opens some other way: release what was held and stand aside.
          plain = true;
          if (heldTextStart) {
            const text = (event.partial.content[ownIndex] as TextContent).text;
            yield { type: "text_start", contentIndex: ownIndex, partial: event.partial };
            if (event.type !== "text_delta" && text) {
              yield {
                type: "text_delta",
                contentIndex: ownIndex,
                delta: text,
                partial: event.partial,
              };
            } else if (event.type === "text_delta" && text.length > event.delta.length) {
              yield {
                type: "text_delta",
                contentIndex: ownIndex,
                delta: text.slice(0, text.length - event.delta.length),
                partial: event.partial,
              };
            }
          }
          yield event;
          continue;
        }
        const { message: partial, index, split } = rewritten;
        if (split.thinking !== undefined) {
          if (!thinkingStarted) {
            thinkingStarted = true;
            yield { type: "thinking_start", contentIndex: index, partial };
          }
          if (split.thinking.length > thinkingSent) {
            const delta = split.thinking.slice(thinkingSent);
            thinkingSent = split.thinking.length;
            yield { type: "thinking_delta", contentIndex: index, delta, partial };
          }
          if ((split.closed || textEnded) && !thinkingEnded) {
            thinkingEnded = true;
            yield { type: "thinking_end", contentIndex: index, content: split.thinking, partial };
          }
          if (split.text.length > textSent) {
            if (!textStarted) {
              textStarted = true;
              yield { type: "text_start", contentIndex: index + 1, partial };
            }
            const delta = split.text.slice(textSent);
            textSent = split.text.length;
            yield { type: "text_delta", contentIndex: index + 1, delta, partial };
          }
        }
        if (own) {
          if (event.type === "text_start") heldTextStart = true;
          else if (event.type === "text_end" && textStarted) {
            yield { type: "text_end", contentIndex: index + 1, content: split.text, partial };
          }
          continue;
        }
        if (!("contentIndex" in event)) {
          yield { ...event, partial };
          continue;
        }
        const shift = split.thinking !== undefined && split.text && event.contentIndex > index;
        yield { ...event, contentIndex: event.contentIndex + (shift ? 1 : 0), partial };
      }
    }
    override result(): Promise<AssistantMessage> {
      return stream.result().then((message) => rewriteMessage(message, true)?.message ?? message);
    }
  }
  return new SplitStream();
}
