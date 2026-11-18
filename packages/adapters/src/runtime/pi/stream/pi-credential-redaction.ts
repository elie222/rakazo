import type {
  AssistantMessage,
  AssistantMessageEvent,
  TextContent,
  ThinkingContent,
} from "@earendil-works/pi-ai";
import { createStreamingRedactor, redactSecrets, sanitizeUtf16ForJson } from "@rakazo/core";

type ContentEnd = Extract<AssistantMessageEvent, { type: "text_end" | "thinking_end" }>;
type ContentDelta = Extract<AssistantMessageEvent, { type: "text_delta" | "thinking_delta" }>;

function indexedRedactor(secrets: string[]) {
  let length = 0;
  const spans: { index: number; end: number }[] = [];
  let writes = new Map<number, string>();
  const redactor = createStreamingRedactor(secrets, (chunks, offset) => {
    for (const chunk of chunks) {
      let at = chunk.start;
      let rest = chunk.text;
      for (const span of spans) {
        if (at >= span.end) continue;
        // A replacement belongs to the block where the protected value starts.
        const size = chunk.replacement ? rest.length : span.end - at;
        writes.set(span.index, (writes.get(span.index) ?? "") + rest.slice(0, size));
        rest = rest.slice(size);
        if (!rest) break;
        at = span.end;
      }
    }
    while (spans[0] && spans[0].end <= offset) spans.shift();
  });
  return {
    push(index: number, delta: string) {
      if (!delta) return;
      length += delta.length;
      const last = spans.at(-1);
      if (last?.index === index) last.end = length;
      else spans.push({ index, end: length });
      redactor.push(delta);
    },
    finish: redactor.finish,
    holds: (index: number) => spans.some((span) => span.index === index),
    takeWrites() {
      const output = writes;
      writes = new Map();
      return output;
    },
  };
}

export function modelCredentialRedaction(apiKey: string) {
  const secrets = [apiKey];
  const redact = (value: string) => redactSecrets(value, secrets);
  // A key may span multiple blocks of the same kind, so both share one matching stream.
  const streams = { text: indexedRedactor(secrets), thinking: indexedRedactor(secrets) };
  const toolStreams = new Map<number, ReturnType<typeof createStreamingRedactor>>();
  const previews = new Map<number, string>();
  const received = new Map<number, { kind: "text" | "thinking"; text: string }>();
  const ends = new Map<number, ContentEnd["type"]>();

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
  function redactBlocks(blocks: (TextContent | ThinkingContent)[], redactPartial: boolean) {
    const stream = indexedRedactor(secrets);
    for (const [index, block] of blocks.entries()) {
      stream.push(index, block.type === "text" ? block.text : block.thinking);
    }
    stream.finish(redactPartial);
    const writes = stream.takeWrites();
    for (const [index, block] of blocks.entries()) {
      const text = writes.get(index) ?? "";
      // A modified signed block can no longer be used with its original signature.
      if (block.type === "thinking" && text !== block.thinking) {
        block.thinking = text;
        delete block.thinkingSignature;
      }
      if (block.type === "text" && text !== block.text) {
        block.text = text;
        delete block.textSignature;
      }
    }
  }

  const message = (raw: AssistantMessage): AssistantMessage => {
    const { content, ...rest } = raw;
    const parts = content.map((part) => ({ ...part }));
    const redactPartial = raw.stopReason === "error" || raw.stopReason === "aborted";
    redactBlocks(
      parts.filter((part) => part.type === "text"),
      redactPartial,
    );
    redactBlocks(
      parts.filter((part) => part.type === "thinking"),
      redactPartial,
    );
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

  function recordDelta(kind: "text" | "thinking", index: number, delta: string) {
    const text = (received.get(index)?.text ?? "") + delta;
    received.set(index, { kind, text });
    streams[kind].push(index, delta);
  }

  function completeBlock(index: number, kind: "text" | "thinking", full: string) {
    const current = received.get(index)?.text ?? "";
    if (full.startsWith(current)) recordDelta(kind, index, full.slice(current.length));
  }

  // Release an end frame only after the last safe delta for that block can be emitted.
  function drain(
    kind: "text" | "thinking",
    snapshot: AssistantMessage,
  ): (ContentDelta | ContentEnd)[] {
    const stream = streams[kind];
    const writes = stream.takeWrites();
    const indices = [...new Set([...ends.keys(), ...writes.keys()])].sort((a, b) => a - b);
    const output: (ContentDelta | ContentEnd)[] = [];
    for (const contentIndex of indices) {
      if (received.get(contentIndex)?.kind !== kind) continue;
      const delta = sanitizeUtf16ForJson(writes.get(contentIndex) ?? "");
      if (delta) {
        previews.set(contentIndex, (previews.get(contentIndex) ?? "") + delta);
        const event: ContentDelta = {
          type: kind === "text" ? "text_delta" : "thinking_delta",
          contentIndex,
          delta,
          partial: partial(snapshot),
        };
        output.push(event);
      }
      const end = ends.get(contentIndex);
      if (end && !stream.holds(contentIndex)) {
        ends.delete(contentIndex);
        output.push({
          type: end,
          contentIndex,
          content: previews.get(contentIndex) ?? "",
          partial: partial(snapshot),
        });
      }
    }
    return output;
  }

  function finish(snapshot: AssistantMessage, redactPartial: boolean): AssistantMessageEvent[] {
    streams.text.finish(redactPartial);
    streams.thinking.finish(redactPartial);
    return [...drain("thinking", snapshot), ...drain("text", snapshot)].sort(
      (a, b) => a.contentIndex - b.contentIndex,
    );
  }

  const events = (
    raw: AssistantMessageEvent,
    previous?: AssistantMessage,
  ): AssistantMessageEvent[] => {
    switch (raw.type) {
      case "done":
      case "error": {
        const terminal = raw.type === "done" ? raw.message : raw.error;
        for (const [index, { kind }] of received) {
          const part = terminal.content[index];
          if (part?.type !== kind) continue;
          completeBlock(index, kind, part.type === "text" ? part.text : part.thinking);
        }
        return [
          ...finish(
            terminal.content.length || !previous ? terminal : previous,
            raw.type === "error",
          ),
          raw.type === "done"
            ? { ...raw, message: message(terminal) }
            : { ...raw, error: message(terminal) },
        ];
      }
      case "text_delta":
      case "thinking_delta": {
        const kind = raw.type === "text_delta" ? "text" : "thinking";
        recordDelta(kind, raw.contentIndex, raw.delta);
        return drain(kind, raw.partial);
      }
      case "text_end":
      case "thinking_end": {
        const kind = raw.type === "text_end" ? "text" : "thinking";
        completeBlock(raw.contentIndex, kind, raw.content);
        ends.set(raw.contentIndex, raw.type);
        return drain(kind, raw.partial);
      }
      case "toolcall_delta": {
        let stream = toolStreams.get(raw.contentIndex);
        if (!stream) {
          stream = createStreamingRedactor(secrets);
          toolStreams.set(raw.contentIndex, stream);
        }
        return [{ ...raw, delta: stream.push(raw.delta), partial: partial(raw.partial) }];
      }
      case "toolcall_end": {
        const { contentIndex } = raw;
        const delta = toolStreams.get(contentIndex)?.finish();
        toolStreams.delete(contentIndex);
        const safePartial = partial(raw.partial);
        const end = { ...raw, toolCall: redactValue(raw.toolCall), partial: safePartial };
        return delta
          ? [{ type: "toolcall_delta", contentIndex, delta, partial: safePartial }, end]
          : [end];
      }
      default:
        return [{ ...raw, partial: partial(raw.partial) }];
    }
  };

  return { events, finish, message, partial, redact };
}
