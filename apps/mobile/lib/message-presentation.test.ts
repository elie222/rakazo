import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  hasVisibleMessagePresentation,
  isCenteredAgentEvent,
  messagePresentationSegments,
  toolBlocksForMessage,
  toolOwnerId,
} from "./message-presentation";

describe("mobile message presentation", () => {
  it("centers handoffs, inter-agent messages, and phone channel mirrors", () => {
    const blocks = [
      { kind: "handoff", fromBotId: "a", toBotId: "b", text: "Go" },
      { kind: "bot_message_sent", toBotId: "b", toBotName: "Research", text: "Go" },
      {
        kind: "bot_message_received",
        fromBotId: "b",
        fromBotName: "Research",
        text: "Done",
      },
      {
        kind: "phone_channel_message",
        channelId: "ch-1",
        fromNumber: "+15551234567",
        fromLabel: "Alex",
        text: "Hello from the group",
      },
    ] as MessageBlock[];

    for (const block of blocks) expect(isCenteredAgentEvent([block])).toBe(true);
    expect(isCenteredAgentEvent([{ kind: "text", text: "Hello" }])).toBe(false);
  });

  it("hides message_bot tool usage when the peer-message marker already represents it", () => {
    const blocks = [
      {
        kind: "steps",
        steps: [
          { label: "Read file", count: 1 },
          { label: "Message bot", count: 1 },
        ],
      },
      { kind: "bot_message_sent", toBotId: "b", toBotName: "Research", text: "Go" },
    ] as MessageBlock[];

    expect(toolBlocksForMessage(blocks)).toEqual([
      { kind: "steps", steps: [{ label: "Read file", count: 1 }] },
    ]);
    expect(
      hasVisibleMessagePresentation([
        { kind: "steps", steps: [{ label: "Message bot", count: 1 }] },
      ]),
    ).toBe(false);
  });

  it("attributes group tool usage to the bot that emitted the message", () => {
    const progress: { botId: string; blocks: MessageBlock[] } = {
      botId: "research",
      blocks: [{ kind: "progress", text: "Using browser", pendingToolNames: ["browser"] }],
    };
    expect(toolOwnerId(progress, true)).toBe("research");
    expect(toolOwnerId({ botId: "research", blocks: [{ kind: "text", text: "done" }] }, true)).toBe(
      undefined,
    );
    expect(toolOwnerId(progress, false)).toBe(undefined);
  });

  it("keeps tool usage in its original place between response content", () => {
    const tool: Extract<MessageBlock, { kind: "steps" }> = {
      kind: "steps",
      steps: [{ label: "Read file", count: 1 }],
    };

    expect(
      messagePresentationSegments([
        { kind: "text", text: "Checking." },
        tool,
        { kind: "text", text: "Done." },
      ]),
    ).toEqual([
      { kind: "content", blocks: [{ kind: "text", text: "Checking." }] },
      { kind: "tool", block: tool },
      { kind: "content", blocks: [{ kind: "text", text: "Done." }] },
    ]);

    expect(
      messagePresentationSegments([
        { kind: "steps", steps: [{ label: "Message bot", count: 1 }] },
        { kind: "text", text: "Done." },
      ]),
    ).toEqual([{ kind: "content", blocks: [{ kind: "text", text: "Done." }] }]);
  });
});
