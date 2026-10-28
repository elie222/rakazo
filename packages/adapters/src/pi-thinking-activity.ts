import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";

/** Observe only explicit provider lifecycle markers, before retry/fallback buffering.
 * Neither reasoning content nor the provider's partial message crosses this boundary.
 * This observes an exposed stream phase, never hidden compute or a quiet connection.
 */
export function withPiThinkingActivity(
  stream: AssistantMessageEventStream,
  setThinking: (active: boolean) => void,
): AssistantMessageEventStream {
  class ThinkingStream extends AssistantMessageEventStream {
    override async *[Symbol.asyncIterator](): AsyncGenerator<AssistantMessageEvent> {
      try {
        for await (const event of stream) {
          if (event.type === "thinking_start") setThinking(true);
          else if (
            event.type === "start" ||
            event.type === "thinking_end" ||
            event.type === "text_start" ||
            event.type === "text_delta" ||
            event.type === "toolcall_start" ||
            event.type === "toolcall_end" ||
            event.type === "done" ||
            event.type === "error"
          )
            setThinking(false);
          yield event;
        }
      } finally {
        setThinking(false);
      }
    }
    override result(): Promise<AssistantMessage> {
      return stream.result();
    }
  }
  return new ThinkingStream();
}
