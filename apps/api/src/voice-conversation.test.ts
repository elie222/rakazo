import type { VoiceConversation } from "@rakazo/adapter-kit";
import type { VoiceConversationEvent } from "@rakazo/contracts";
import { expect, it, vi } from "vitest";
import { streamVoiceConversation } from "./voice-conversation.js";

it("dispatches each delegation once and closes/persists on completion", async () => {
  const events: VoiceConversationEvent[] = [
    { type: "transcript", id: "a", role: "user", text: "Find my notes", startMs: 0, endMs: 5 },
    { type: "delegation", id: "d" },
    { type: "delegation", id: "d" },
    { type: "closed" },
  ];
  const close = vi.fn(async () => {});
  const save = vi.fn(async () => {});
  const delegate = vi.fn(async () => "Found the notes.");
  const session: VoiceConversation = {
    answerSdp: "answer",
    close,
    respond: vi.fn(),
    events: (async function* () {
      yield* events;
    })(),
  };
  const seen = [];
  for await (const e of streamVoiceConversation({
    session,
    delegate,
    save,
    authorized: async () => true,
  }))
    seen.push(e);
  expect(seen[0]).toEqual({ type: "connected", answerSdp: "answer" });
  expect(delegate).toHaveBeenCalledExactlyOnceWith("Find my notes", "d", [
    { role: "user", text: "Find my notes", startMs: 0, endMs: 5 },
  ]);
  expect(close).toHaveBeenCalledOnce();
  expect(save).toHaveBeenCalledWith([
    { role: "user", text: "Find my notes", startMs: 0, endMs: 5 },
  ]);
});

it("fails closed when authorization is revoked", async () => {
  const close = vi.fn(async () => {});
  const delegate = vi.fn();
  const session: VoiceConversation = {
    answerSdp: "answer",
    close,
    respond: vi.fn(),
    events: (async function* () {
      yield { type: "heartbeat" as const };
    })(),
  };
  const stream = streamVoiceConversation({
    session,
    delegate,
    save: async () => {},
    authorized: async () => false,
  });
  await expect(stream.next()).rejects.toThrow();
  expect(close).toHaveBeenCalledOnce();
  expect(delegate).not.toHaveBeenCalled();
});

it("passes the assistant's spoken question with a follow-up delegation", async () => {
  const delegate = vi.fn(async () => "Done.");
  const session: VoiceConversation = {
    answerSdp: "answer",
    close: async () => {},
    respond: vi.fn(),
    events: (async function* () {
      yield {
        type: "transcript" as const,
        id: "q",
        role: "bot" as const,
        text: "Use the second draft?",
        startMs: 0,
        endMs: 5,
      };
      yield {
        type: "transcript" as const,
        id: "a",
        role: "user" as const,
        text: "Yes",
        startMs: 10,
        endMs: 15,
      };
      yield { type: "delegation" as const, id: "d" };
      yield { type: "closed" as const };
    })(),
  };
  for await (const _ of streamVoiceConversation({
    session,
    delegate,
    authorized: async () => true,
    save: async () => {},
  })) {
    /* Drain the stream. */
  }
  expect(delegate).toHaveBeenCalledWith("Yes", "d", [
    { role: "bot", text: "Use the second draft?", startMs: 0, endMs: 5 },
    { role: "user", text: "Yes", startMs: 10, endMs: 15 },
  ]);
});
