import { describe, expect, it } from "vitest";
import {
  commentaryChunks,
  decodeLiveVoiceEvent,
  liveVoiceConfiguration,
} from "./openai-live-voice.js";
import { createVoiceProvider, voiceCatalogEntry } from "./voice-factory.js";

describe("conversational voice", () => {
  it("offers an opt-in connection with the existing credential flow", () => {
    expect(voiceCatalogEntry("openai-live")?.conversational).toBe(true);
    expect(createVoiceProvider("openai-live").converse).toBeTypeOf("function");
  });
  it("keeps backend delegation in the application and never accepts arbitrary voices", () => {
    expect(liveVoiceConfiguration({ voiceId: "marin", instructions: "Be helpful." })).toMatchObject(
      {
        model: "gpt-live-1",
        delegation: { type: "client" },
        audio: { output: { voice: "marin" } },
      },
    );
    expect(() => liveVoiceConfiguration({ voiceId: "not-a-voice", instructions: "" })).toThrow();
  });
  it("normalizes timed transcripts without losing whitespace", () => {
    expect(
      decodeLiveVoiceEvent({
        type: "session.input_transcript.delta",
        event_id: "a",
        delta: " hello",
        start_ms: 10,
        end_ms: 20,
      }),
    ).toEqual({
      type: "transcript",
      id: "a",
      role: "user",
      text: " hello",
      startMs: 10,
      endMs: 20,
    });
    expect(
      decodeLiveVoiceEvent({ type: "session.input_transcript.delta", delta: {}, start_ms: -1 }),
    ).toBeNull();
  });
  it("does not expose reflected audio or provider error payloads", () => {
    expect(
      decodeLiveVoiceEvent({ type: "session.input_audio.append", audio: "private" }),
    ).toBeNull();
    expect(decodeLiveVoiceEvent({ type: "error", error: { message: "private-key" } })).toEqual({
      type: "error",
      message: "The voice connection failed. Please reconnect.",
    });
  });
  it("preserves delegation identity and explicit closure", () => {
    expect(
      decodeLiveVoiceEvent({
        type: "session.delegation.created",
        delegation: { id: "d1", target: "client" },
      }),
    ).toEqual({ type: "delegation", id: "d1" });
    expect(decodeLiveVoiceEvent({ type: "session.closed" })).toEqual({ type: "closed" });
  });
});

it("preserves complete multilingual results within each commentary budget", () => {
  const content = "Olá 🌍 日本語 ".repeat(200);
  const chunks = commentaryChunks(content);
  expect(chunks.join("")).toBe(content);
  expect(chunks.every((part) => new TextEncoder().encode(part).length <= 450)).toBe(true);
});

it("seeds the incoming opening at creation, before sideband attachment", () => {
  expect(
    liveVoiceConfiguration({ voiceId: "marin", instructions: "", opening: "Your report is ready." })
      .input,
  ).toEqual([
    {
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: expect.stringContaining("Your report is ready.") }],
    },
  ]);
});
