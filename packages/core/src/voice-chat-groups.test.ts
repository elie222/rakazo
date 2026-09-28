import type { ThreadMessage } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  groupVoiceChats,
  latestSpokenCallReply,
  voiceChatDuration,
  voiceChatSummary,
} from "./voice-chat-groups.js";

let seq = 0;
function message(fields: Partial<ThreadMessage> & { role: ThreadMessage["role"] }): ThreadMessage {
  seq += 1;
  return {
    id: `message-${seq}`,
    threadId: "thread-1",
    seq,
    blocks: [{ kind: "text", text: "Hello" }],
    createdAt: new Date(Date.UTC(2026, 7, 16, 0, 0, seq)).toISOString(),
    ...fields,
  };
}

describe("groupVoiceChats", () => {
  it("keeps two calls in separate groups", () => {
    const items = groupVoiceChats([
      message({ role: "user", callId: "call-1" }),
      message({ role: "user", callId: "call-2" }),
    ]);

    expect(items.map((item) => item.kind)).toEqual(["voiceChat", "voiceChat"]);
    expect(items.flatMap((item) => (item.kind === "voiceChat" ? [item.callId] : []))).toEqual([
      "call-1",
      "call-2",
    ]);
  });

  it("breaks a group when a typed message lands between call turns", () => {
    const items = groupVoiceChats([
      message({ role: "user", callId: "call-1" }),
      message({ role: "user" }),
      message({ role: "user", callId: "call-1" }),
    ]);

    expect(items.map((item) => item.kind)).toEqual(["voiceChat", "message", "voiceChat"]);
  });

  it("does not speak a typed concurrent reply into the call", () => {
    const callTurn = message({ role: "user", callId: "call-1", runId: "run-1" });
    const callReply = message({ role: "bot", runId: "run-1" });
    const typed = message({ role: "user", runId: "run-1" });
    const typedReply = message({
      role: "bot",
      runId: "run-1",
      blocks: [{ kind: "text", text: "Typed answer" }],
    });

    expect(latestSpokenCallReply([callTurn, callReply], "call-1")?.id).toBe(callReply.id);
    expect(latestSpokenCallReply([callTurn, callReply, typed, typedReply], "call-1")?.id).toBe(
      callReply.id,
    );
  });

  it("stops offering a spoken reply once the hang-up marker closed the card", () => {
    const callTurn = message({ role: "user", callId: "call-1", runId: "run-1" });
    const callReply = message({ role: "bot", runId: "run-1" });
    const marker = message({
      role: "bot",
      runId: "run-1",
      callId: "call-1",
      blocks: [{ kind: "voice_call", callId: "call-1", title: "Done", farewell: "Bye" }],
    });
    const wrapUp = message({
      role: "bot",
      runId: "run-1",
      blocks: [{ kind: "text", text: "Here is the list" }],
    });

    expect(latestSpokenCallReply([callTurn, callReply, marker, wrapUp], "call-1")).toBeUndefined();
  });

  it("numbers the segments a typed message split a call into, and keeps them across pages", () => {
    const opening = message({ role: "user", callId: "call-1" });
    const resumed = message({ role: "user", callId: "call-1" });
    const page = [opening, message({ role: "user" }), resumed];

    expect(
      groupVoiceChats(page).flatMap((item) => (item.kind === "voiceChat" ? [item.key] : [])),
    ).toEqual(["call:call-1", "call:call-1:2"]);

    // An older page lands in front and extends the first segment: the keys hold.
    const older = [message({ role: "bot", callId: "call-1" }), ...page];
    expect(
      groupVoiceChats(older).flatMap((item) => (item.kind === "voiceChat" ? [item.key] : [])),
    ).toEqual(["call:call-1", "call:call-1:2"]);
  });

  it("joins the bot reply to the call by runId", () => {
    const items = groupVoiceChats([
      message({ role: "user", callId: "call-1", runId: "run-1" }),
      message({ role: "bot", runId: "run-1" }),
      message({ role: "user" }),
    ]);

    expect(items).toHaveLength(2);
    expect(items[0]?.kind === "voiceChat" && items[0].messages).toHaveLength(2);
    expect(items[1]?.kind).toBe("message");
  });

  it("leaves a typed message and its reply out of the card even on the call's run", () => {
    const items = groupVoiceChats([
      message({ role: "user", callId: "call-1", runId: "run-1" }),
      message({ role: "bot", runId: "run-1" }),
      message({ role: "user", runId: "run-1" }),
      message({ role: "bot", runId: "run-1" }),
    ]);

    expect(items.map((item) => item.kind)).toEqual(["voiceChat", "message", "message"]);
    expect(items[0]?.kind === "voiceChat" && items[0].messages).toHaveLength(2);
  });

  it("closes the group at the call marker and leaves later work of that run outside", () => {
    const items = groupVoiceChats([
      message({ role: "user", callId: "call-1", runId: "run-1" }),
      message({ role: "bot", runId: "run-1" }),
      message({
        role: "bot",
        runId: "run-1",
        blocks: [{ kind: "voice_call", callId: "call-1", title: "Made a list", farewell: "Bye" }],
      }),
      message({
        role: "bot",
        runId: "run-1",
        blocks: [{ kind: "text", text: "Here is the list" }],
      }),
    ]);

    const group = items[0];
    expect(items.map((item) => item.kind)).toEqual(["voiceChat", "message"]);
    expect(group?.kind === "voiceChat" && group.messages).toHaveLength(3);
    expect(group?.kind === "voiceChat" && group.marker?.id).toBe(
      group?.kind === "voiceChat" ? group.messages[2]?.id : undefined,
    );
  });
});

describe("voiceChatSummary", () => {
  it("takes the first sentence of the first spoken bot reply", () => {
    const [group] = groupVoiceChats([
      message({ role: "user", callId: "call-1", runId: "run-1" }),
      message({
        role: "bot",
        runId: "run-1",
        blocks: [{ kind: "text", text: "Deploy is green. I also restarted the worker." }],
      }),
    ]);

    expect(group?.kind === "voiceChat" && voiceChatSummary(group)).toBe("Deploy is green.");
  });

  it("prefers the title the bot hung up with", () => {
    const [group] = groupVoiceChats([
      message({ role: "user", callId: "call-1", runId: "run-1" }),
      message({
        role: "bot",
        runId: "run-1",
        blocks: [{ kind: "text", text: "Deploy is green. I also restarted the worker." }],
      }),
      message({
        role: "bot",
        runId: "run-1",
        blocks: [{ kind: "voice_call", callId: "call-1", title: "Deploy check", farewell: "Bye" }],
      }),
    ]);

    expect(group?.kind === "voiceChat" && voiceChatSummary(group)).toBe("Deploy check");
  });
});

describe("voiceChatDuration", () => {
  it("counts whole seconds between the first and last turn", () => {
    const start = message({ role: "user", callId: "call-1", runId: "run-1" });
    const end = message({ role: "bot", runId: "run-1" });
    const [group] = groupVoiceChats([start, end]);

    expect(group?.kind === "voiceChat" && voiceChatDuration(group)).toBe(
      Math.round((Date.parse(end.createdAt) - Date.parse(start.createdAt)) / 1000),
    );
  });
});
