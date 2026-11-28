const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_EVENT_CHARS = 128 * 1024;
const MAX_LINES = 32_768;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Verifies one bounded Kimi text response body on the trusted egress side.
 * The caller must validate the HTTP status/content type and the exact
 * run/connection/route before feeding bytes. This does not authorize publishing:
 * it neither binds a request nor checks the worker lease.
 */
export function createKimiSseCompletionObserver(expectedWireModel: string) {
  const decode = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  let data: string | undefined;
  let responseId: string | undefined;
  let bytes = 0;
  let lines = 0;
  let textSeen = false;
  let stopped = false;
  let usageSeen = false;
  let done = false;
  let closed = false;
  let invalid = !expectedWireModel;

  function event(payload: string): boolean {
    if (done) return false;
    if (payload === "[DONE]") {
      if (!stopped || !textSeen) return false;
      done = true;
      return true;
    }

    const chunk = record(JSON.parse(payload));
    if (
      !chunk ||
      "error" in chunk ||
      chunk.object !== "chat.completion.chunk" ||
      chunk.model !== expectedWireModel ||
      typeof chunk.id !== "string" ||
      !chunk.id ||
      (responseId !== undefined && responseId !== chunk.id) ||
      !Array.isArray(chunk.choices)
    )
      return false;
    responseId = chunk.id;
    if (chunk.choices.length === 0) {
      if (!stopped || usageSeen || !record(chunk.usage)) return false;
      usageSeen = true;
      return true;
    }
    if (stopped || chunk.choices.length !== 1) return false;
    const choice = record(chunk.choices[0]);
    const delta = record(choice?.delta);
    if (
      choice?.index !== 0 ||
      !delta ||
      "tool_calls" in delta ||
      "function_call" in delta ||
      (delta.role !== undefined && delta.role !== "assistant") ||
      (delta.content != null && typeof delta.content !== "string") ||
      (choice.finish_reason !== null && choice.finish_reason !== "stop")
    )
      return false;
    if (typeof delta.content === "string" && delta.content.trim()) textSeen = true;
    stopped = choice.finish_reason === "stop";
    return true;
  }

  function line(raw: string): boolean {
    if (++lines > MAX_LINES) return false;
    const value = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (value.includes("\r")) return false;
    if (value === "") {
      const payload = data;
      data = undefined;
      return payload === undefined || event(payload);
    }
    if (value.startsWith(":")) return true;
    // The pinned provider sends one data line per event. Unknown fields and
    // multi-line event payloads are out of scope, not silently discarded.
    if (done || data !== undefined || !value.startsWith("data:")) return false;
    data = value.slice(value.startsWith("data: ") ? 6 : 5);
    return true;
  }

  function fail() {
    invalid = true;
    pending = "";
    data = undefined;
    responseId = undefined;
    return false;
  }

  return {
    /** Observe bytes from the one trusted HTTP body. Never retain answer text. */
    push(chunk: Uint8Array): boolean {
      bytes += chunk.byteLength;
      if (closed || invalid || bytes > MAX_BODY_BYTES) return fail();
      try {
        const parts = decode.decode(chunk, { stream: true }).split("\n");
        for (let index = 0; index < parts.length; index++) {
          pending += parts[index];
          if (pending.length > MAX_EVENT_CHARS) return fail();
          if (index === parts.length - 1) break;
          if (!line(pending)) return fail();
          pending = "";
        }
        return true;
      } catch {
        return fail();
      }
    },
    /** Call once, only after the HTTP stack reports successful end of body. */
    finish(): boolean {
      if (closed) return false;
      closed = true;
      try {
        // An unterminated data event or partial UTF-8 sequence is not success.
        return !invalid && !decode.decode() && !pending && data === undefined && done;
      } catch {
        return fail();
      }
    },
    /** Abort, transport error, or rejected HTTP response: never turn this into EOF. */
    discard(): void {
      closed = true;
      fail();
    },
  };
}
