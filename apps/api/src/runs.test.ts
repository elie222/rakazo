import { describe, expect, it } from "vitest";
import { activityNotificationsEnabled, activityPreview } from "./runs.js";

describe("run activity copy", () => {
  it("presents structured agent messages instead of their internal wake prompt", () => {
    expect(
      activityPreview({
        trigger: "bot_message",
        prompt: "[bot] A message just arrived from another bot with internal routing data",
        sourceBlocks: [
          {
            kind: "bot_message_received",
            fromBotId: "maya",
            fromBotName: "Maya",
            text: "Please check the release workflow.",
            intent: "request",
          },
        ],
      }),
    ).toEqual({
      promptSnippet: "Please check the release workflow.",
      agentMessage: { fromBotName: "Maya", kind: "request" },
    });
  });

  it.each(["result", "status", "fyi"])(
    "classifies %s as an update without server copy",
    (intent) => {
      expect(
        activityPreview({
          trigger: "bot_message",
          prompt: "internal",
          sourceBlocks: [
            {
              kind: "bot_message_received",
              fromBotId: "peer",
              fromBotName: "  ",
              intent,
              text: " first\n second ",
            },
          ],
        }),
      ).toEqual({
        promptSnippet: "first second",
        agentMessage: { fromBotName: "", kind: "update" },
      });
    },
  );

  it("preserves ordinary snippets and caps only message text", () => {
    expect(activityPreview({ trigger: "user", prompt: " hello\n world " })).toEqual({
      promptSnippet: "hello world",
      agentMessage: null,
    });
    expect(
      activityPreview({
        trigger: "bot_message",
        prompt: "internal",
        sourceBlocks: [
          {
            kind: "bot_message_received",
            fromBotId: "peer",
            fromBotName: "Peer",
            intent: "request",
            text: "x".repeat(130),
          },
        ],
      }).promptSnippet,
    ).toBe(`${"x".repeat(119)}…`);
  });

  it("fails closed when an agent message has no valid structured source", () => {
    expect(
      activityPreview({
        trigger: "bot_message",
        prompt: "[bot] private internal routing envelope",
        sourceBlocks: [{ kind: "text", text: "not a peer message" }],
      }),
    ).toEqual({ promptSnippet: "", agentMessage: null });
  });
});

describe("run activity notification preference", () => {
  it("silences only direct messages", () => {
    expect(activityNotificationsEnabled(null, false)).toBe(false);
    expect(activityNotificationsEnabled("group-1", false)).toBe(true);
  });
});
