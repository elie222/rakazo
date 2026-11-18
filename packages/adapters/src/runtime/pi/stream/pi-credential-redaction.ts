import type {
  AssistantMessage,
  AssistantMessageEvent,
  TextContent,
  ThinkingContent,
} from "@earendil-works/pi-ai";
import { createStreamingRedactor, redactedRanges, redactSecrets } from "@rakazo/core";

export function modelCredentialRedaction(apiKey: string) {
  const secrets = [apiKey];
  const redact = (value: string) => redactSecrets(value, secrets);
  const textStream = createStreamingRedactor(secrets);
  const thinkingStream = createStreamingRedactor(secrets);
  const toolStreams = new Map<number, ReturnType<typeof createStreamingRedactor>>();
  const previews = new Map<number, string>();
  let lastTextIndex: number | undefined;
  let emittedText = "";

  function redactValue<T>(value: T): T {
    if (typeof value === "string") return redact(value) as T;
    if (Array.isArray(value)) return value.map(redactValue) as T;
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, nested]) => [redact(key), redactValue(nested)]),
      ) as T;
    return value;
  }

  // Pi concatenates each kind of text block. A match can cross a block boundary.
  function redactBlocks(blocks: (TextContent | ThinkingContent)[]) {
    const values = blocks.map((block) => (block.type === "text" ? block.text : block.thinking));
    const ranges = redactedRanges(values.join(""), secrets);
    let offset = 0;
    let rangeIndex = 0;
    for (let index = 0; index < blocks.length; index += 1) {
      const value = values[index]!;
      const blockEnd = offset + value.length;
      let text = "";
      let from = offset;
      while (ranges[rangeIndex] && ranges[rangeIndex]![0] < blockEnd) {
        const [start, end] = ranges[rangeIndex]!;
        if (start >= offset) text += value.slice(from - offset, start - offset) + "[redacted]";
        from = Math.max(from, end);
        if (end > blockEnd) break;
        rangeIndex += 1;
      }
      text += value.slice(from - offset);
      const block = blocks[index]!;
      // A modified signed block can no longer be used with its original signature.
      if (text !== value) {
        if (block.type === "thinking") {
          block.thinking = text;
          delete block.thinkingSignature;
        } else {
          block.text = text;
          delete block.textSignature;
        }
      }
      offset = blockEnd;
    }
  }

  const message = (raw: AssistantMessage): AssistantMessage => {
    const { content, ...rest } = raw;
    const parts = content.map((part) => ({ ...part }));
    redactBlocks(parts.filter((part) => part.type === "text"));
    redactBlocks(parts.filter((part) => part.type === "thinking"));
    return { ...redactValue(rest), content: redactValue(parts) };
  };

  const partial = (raw: AssistantMessage): AssistantMessage => {
    const { content, ...rest } = raw;
    return {
      ...redactValue(rest),
      content: content.map((part, index) => {
        if (part.type === "text")
          return { ...redactValue({ ...part, text: "" }), text: previews.get(index) ?? "" };
        if (part.type === "thinking")
          return { ...redactValue({ ...part, thinking: "" }), thinking: previews.get(index) ?? "" };
        return redactValue({ ...part, arguments: {} });
      }),
    };
  };

  const event = (raw: AssistantMessageEvent): AssistantMessageEvent => {
    if (raw.type === "done") return { ...raw, message: message(raw.message) };
    if (raw.type === "error") return { ...raw, error: message(raw.error) };
    if (raw.type === "text_delta" || raw.type === "thinking_delta") {
      const stream = raw.type === "text_delta" ? textStream : thinkingStream;
      const delta = stream.push(raw.delta);
      if (raw.type === "text_delta") {
        lastTextIndex = raw.contentIndex;
        emittedText += delta;
      }
      previews.set(raw.contentIndex, (previews.get(raw.contentIndex) ?? "") + delta);
      return { ...raw, delta, partial: partial(raw.partial) };
    }
    if (raw.type === "text_end" || raw.type === "thinking_end") {
      // Keep the tail buffered across content blocks. The terminal message supplies it.
      return {
        ...raw,
        content: previews.get(raw.contentIndex) ?? "",
        partial: partial(raw.partial),
      };
    }
    if (raw.type === "toolcall_delta") {
      let stream = toolStreams.get(raw.contentIndex);
      if (!stream) {
        stream = createStreamingRedactor(secrets);
        toolStreams.set(raw.contentIndex, stream);
      }
      return { ...raw, delta: stream.push(raw.delta), partial: partial(raw.partial) };
    }
    if (raw.type === "toolcall_end")
      return { ...raw, toolCall: redactValue(raw.toolCall), partial: partial(raw.partial) };
    return { ...raw, partial: partial(raw.partial) };
  };

  function trailingDelta(safeEvent: AssistantMessageEvent): AssistantMessageEvent | undefined {
    if (safeEvent.type === "toolcall_end") {
      const { contentIndex, partial } = safeEvent;
      const delta = toolStreams.get(contentIndex)?.finish();
      toolStreams.delete(contentIndex);
      if (delta) return { type: "toolcall_delta", contentIndex, delta, partial };
      return;
    }
    if (safeEvent.type !== "done" || lastTextIndex === undefined) return;
    const safeMessage = safeEvent.message;
    const text = safeMessage.content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("");
    if (!text.startsWith(emittedText) || text === emittedText) return;
    // Keep tool narration complete after buffering across content blocks.
    return {
      type: "text_delta",
      contentIndex: lastTextIndex,
      delta: text.slice(emittedText.length),
      partial: safeMessage,
    };
  }

  return { event, trailingDelta, message, redact };
}
