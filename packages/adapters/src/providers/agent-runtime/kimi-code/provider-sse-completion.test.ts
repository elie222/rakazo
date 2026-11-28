import { describe, expect, it } from "vitest";
import { createKimiSseCompletionObserver } from "./provider-sse-completion.js";

const encode = (text: string) => new TextEncoder().encode(text);
const model = "fixture-wire-model";
const event = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
const chunk = (choices: unknown[], extra = {}) =>
  event({ object: "chat.completion.chunk", id: "fixture-response", model, choices, ...extra });
const choice = (delta: object, finishReason: string | null = null) => ({
  index: 0,
  delta,
  finish_reason: finishReason,
});
const text = chunk([choice({ content: "Hello 🐈" })]);
const stop = chunk([choice({}, "stop")]);
const usage = chunk([], { usage: { total_tokens: 8 } });
const done = "data: [DONE]\n\n";

function read(body: string, expected = model) {
  const observer = createKimiSseCompletionObserver(expected);
  observer.push(encode(body));
  return observer.finish();
}

describe("Kimi provider SSE completion", () => {
  it("verifies the exact full response and accepts split UTF-8 and CRLF framing", () => {
    const observer = createKimiSseCompletionObserver(model);
    for (const byte of encode((text + stop + usage + done).replaceAll("\n", "\r\n"))) {
      expect(observer.push(Uint8Array.of(byte))).toBe(true);
    }
    expect(observer.finish()).toBe(true);
    expect(observer.finish()).toBe(false);
  });

  it("accepts clean completion without optional usage", () => {
    expect(read(text + stop + done)).toBe(true);
  });

  it.each([
    ["delta only", text],
    ["stop without the terminal marker", text + stop],
    ["terminator without a stop", text + done],
    ["a length-limited answer", text + chunk([choice({}, "length")]) + done],
    ["no answer", stop + done],
    ["provider error even with a later stop", text + event({ error: {} }) + stop + done],
    ["unframed EOF", text + stop + done.trimEnd()],
    ["data after the terminal marker", text + stop + done + text],
    ["a second usage event", text + stop + usage + usage + done],
    ["a tool call", chunk([choice({ tool_calls: [{ index: 0 }] })]) + text + stop + done],
    ["a different response ID", text + chunk([choice({}, "stop")], { id: "other" }) + done],
  ])("never certifies %s", (_case, body) => {
    expect(read(body)).toBe(false);
  });

  it("does not confuse the CLI alias with the provider model ID", () => {
    expect(read(text + stop + done, "local-cli-alias")).toBe(false);
  });

  it("does not certify a body when the transport errors after the logical terminator", () => {
    const observer = createKimiSseCompletionObserver(model);
    expect(observer.push(encode(text + stop + done))).toBe(true);
    observer.discard();
    expect(observer.finish()).toBe(false);
  });

  it("rejects invalid UTF-8 even after the terminator", () => {
    const observer = createKimiSseCompletionObserver(model);
    expect(observer.push(encode(text + stop + done))).toBe(true);
    expect(observer.push(Uint8Array.of(0xc3))).toBe(true);
    expect(observer.finish()).toBe(false);
  });

  it("bounds incomplete lines and total body bytes", () => {
    const observer = createKimiSseCompletionObserver(model);
    expect(observer.push(encode(`data: ${"a".repeat(128 * 1024)}`))).toBe(false);
    const another = createKimiSseCompletionObserver(model);
    expect(another.push(new Uint8Array(2 * 1024 * 1024 + 1))).toBe(false);
    expect(another.finish()).toBe(false);
  });

  it("keeps simultaneous observations for the same wire model independent", () => {
    const a = createKimiSseCompletionObserver(model);
    const b = createKimiSseCompletionObserver(model);
    expect(a.push(encode(text))).toBe(true);
    expect(b.push(encode(text + stop))).toBe(true);
    expect(a.push(encode(stop + done))).toBe(true);
    expect(b.finish()).toBe(false);
    expect(a.finish()).toBe(true);
  });
});
