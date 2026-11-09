import { describe, expect, it } from "vitest";
import { nextAutoSpeakAction, readAloudText } from "./auto-speak";

describe("readAloudText", () => {
  it("reads only the reply's own words, never the working narration ahead of them", () => {
    expect(
      readAloudText([
        { kind: "progress", text: "Using browser" },
        { kind: "text", text: "Shanghai is 18 degrees today." },
      ]),
    ).toBe("Shanghai is 18 degrees today.");
  });

  it("drops system notes, tool steps and subagent status, keeps the reply and its question", () => {
    expect(
      readAloudText([
        { kind: "meta", text: "Run stopped." },
        { kind: "steps", steps: [{ label: "weather", count: 1 }] },
        { kind: "text", text: "Done." },
        { kind: "ask", text: "Ship it?", status: "pending" },
        {
          kind: "subagent",
          agentId: "agent-1",
          name: "Scout",
          task: "check the weather",
          status: "completed",
          result: "Scout finished",
        },
      ]),
    ).toBe("Done.\nShip it?");
  });

  it("is empty when a message holds no reply text at all", () => {
    expect(readAloudText([{ kind: "progress", text: "Using browser" }])).toBe("");
  });
});

function textMessage(id: string, text: string) {
  return {
    id,
    role: "bot" as const,
    blocks: [{ kind: "text" as const, text }],
  };
}

describe("nextAutoSpeakAction", () => {
  const base = {
    botId: "bot-1",
    autoSpeak: true,
    callActive: false,
    focused: true,
    snapshotReady: true,
    lastSpokenBotId: "bot-1",
    lastSpokenMessageId: "msg-1",
    runStatus: "completed" as string | null,
    messages: [textMessage("msg-1", "Earlier."), textMessage("msg-2", "Hello from the bot.")],
  };

  it("seeds the latest reply when opening a bot so history is not spoken", () => {
    expect(
      nextAutoSpeakAction({
        ...base,
        lastSpokenBotId: null,
        lastSpokenMessageId: null,
      }),
    ).toEqual({ action: "seed", messageId: "msg-2" });
  });

  it("waits until the thread snapshot belongs to this bot", () => {
    expect(nextAutoSpeakAction({ ...base, snapshotReady: false })).toEqual({ action: "wait" });
  });

  it("seeds when autoSpeak is off so enabling later does not dump the last reply", () => {
    expect(nextAutoSpeakAction({ ...base, autoSpeak: false })).toEqual({
      action: "seed",
      messageId: "msg-2",
    });
  });

  it("waits while the thread is not focused instead of speaking in the background", () => {
    expect(nextAutoSpeakAction({ ...base, focused: false })).toEqual({ action: "wait" });
  });

  it("waits while a run is still in flight", () => {
    expect(nextAutoSpeakAction({ ...base, runStatus: "running" })).toEqual({ action: "wait" });
    expect(nextAutoSpeakAction({ ...base, runStatus: "queued" })).toEqual({ action: "wait" });
    expect(nextAutoSpeakAction({ ...base, runStatus: "leased" })).toEqual({ action: "wait" });
  });

  it("seeds while a call is active, before the run gate, so a streamed reply stays unspoken", () => {
    expect(nextAutoSpeakAction({ ...base, callActive: true })).toEqual({
      action: "seed",
      messageId: "msg-2",
    });
    expect(nextAutoSpeakAction({ ...base, callActive: true, runStatus: "running" })).toEqual({
      action: "seed",
      messageId: "msg-2",
    });
  });

  it("speaks a finished reply that has not been spoken yet", () => {
    expect(nextAutoSpeakAction(base)).toEqual({
      action: "speak",
      messageId: "msg-2",
      text: "Hello from the bot.",
    });
  });

  it("does not read the working narration ahead of a finished reply", () => {
    expect(
      nextAutoSpeakAction({
        ...base,
        messages: [
          {
            id: "msg-2",
            role: "bot",
            blocks: [
              { kind: "progress", text: "Using browser" },
              { kind: "text", text: "Hello from the bot." },
            ],
          },
        ],
      }),
    ).toEqual({
      action: "speak",
      messageId: "msg-2",
      text: "Hello from the bot.",
    });
  });

  it("does not speak the same reply twice", () => {
    expect(nextAutoSpeakAction({ ...base, lastSpokenMessageId: "msg-2" })).toEqual({
      action: "wait",
    });
  });

  it("marks an empty reply spoken without playing it", () => {
    expect(
      nextAutoSpeakAction({
        ...base,
        messages: [textMessage("msg-2", "   ")],
      }),
    ).toEqual({ action: "seed", messageId: "msg-2" });
  });
});
