import { describe, expect, it } from "vitest";
import { activityNotificationsEnabled, activityPreview } from "./runs.js";

describe("run activity copy", () => {
  it.each([
    [
      "request",
      "Maya",
      "Please check the release workflow.",
      "Maya asked: Please check the release workflow.",
      "request",
    ],
    ["result", "Maya", "Ready", "Update from Maya: Ready", "update"],
    ["status", "Maya", "Ready", "Update from Maya: Ready", "update"],
    ["fyi", "Maya", "Ready", "Update from Maya: Ready", "update"],
    ["request", "  ", " first\n second ", "Another agent asked: first second", "request"],
    ["result", "  ", " first\n second ", "Update from Another agent: first second", "update"],
    ["request", " Maya ", " \n ", "Maya asked", "request"],
    ["result", " Maya ", "", "Update from Maya", "update"],
    ["request", "", "", "Another agent asked", "request"],
    ["result", "", "", "Update from Another agent", "update"],
  ])(
    "preserves the legacy label for %s from '%s' with text '%s'",
    (intent, fromBotName, text, legacy, kind) => {
      expect(
        activityPreview({
          trigger: "bot_message",
          prompt: "[bot] private internal routing envelope",
          sourceBlocks: [
            { kind: "bot_message_received", fromBotId: "peer", fromBotName, text, intent },
          ],
        }),
      ).toEqual({
        promptSnippet: legacy,
        agentMessage: {
          fromBotName: fromBotName.trim(),
          kind,
          text: text.replace(/\s+/g, " ").trim(),
        },
      });
    },
  );

  it("caps the whole legacy label and the structured text independently", () => {
    expect(activityPreview({ trigger: "user", prompt: " hello\n world " })).toEqual({
      promptSnippet: "hello world",
      agentMessage: null,
    });
    const preview = activityPreview({
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
    });
    expect(preview).toEqual({
      promptSnippet: `Peer asked: ${"x".repeat(107)}…`,
      agentMessage: { fromBotName: "Peer", kind: "request", text: `${"x".repeat(119)}…` },
    });
    expect(activityPreview({ trigger: "user", prompt: "x".repeat(130) }).promptSnippet).toBe(
      `${"x".repeat(119)}…`,
    );
  });

  it.each([
    undefined,
    null,
    [],
    [{ kind: "invalid" }],
    [{ kind: "text", text: "not a peer message" }],
  ])("fails closed when an agent message has no valid structured source: %j", (sourceBlocks) => {
    expect(
      activityPreview({
        trigger: "bot_message",
        prompt: "[bot] private internal routing envelope",
        sourceBlocks,
      }),
    ).toEqual({ promptSnippet: "Message from another agent", agentMessage: { kind: "unknown" } });
  });
});

describe("run activity notification preference", () => {
  it("silences only direct messages", () => {
    expect(activityNotificationsEnabled(null, false)).toBe(false);
    expect(activityNotificationsEnabled("group-1", false)).toBe(true);
  });
});
