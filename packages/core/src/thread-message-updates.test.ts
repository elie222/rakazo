import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  takeLiveMessage,
  updateCloudAgentMessages,
  updateMessageReaction,
} from "./thread-message-updates.js";

const cloud = (agentId: string): MessageBlock => ({
  kind: "cloud_agent",
  agentId,
  title: "Agent",
  status: "running",
  url: "",
});

describe("shared message updates", () => {
  it("takes only the matching run and drops obsolete unscoped progress in order", () => {
    const messages = [
      { id: "first" },
      { id: "progress:legacy" },
      { id: "progress:current", runId: "current" },
      { id: "progress:other", runId: "other" },
      { id: "last" },
    ];
    const result = takeLiveMessage(messages, "progress:current");
    expect(result.previous).toBe(messages[2]);
    expect(result.remaining).toEqual([messages[0], messages[3], messages[4]]);
    expect(messages).toHaveLength(5);
  });

  it("updates every matching cloud block while preserving metadata and unrelated messages", () => {
    const messages = [
      { id: "first", replyToMessageId: "reply", blocks: [cloud("agent"), cloud("other")] },
      { id: "second", replyToMessageId: "reply", blocks: [cloud("agent")] },
      {
        id: "third",
        replyToMessageId: "reply",
        blocks: [{ kind: "text", text: "unchanged" } as MessageBlock],
      },
    ];
    const result = updateCloudAgentMessages(messages, {
      messageId: "first",
      agentId: "agent",
      status: "finished",
    });
    expect(result.map((message) => message.id)).toEqual(["first", "second", "third"]);
    expect(result[0]?.replyToMessageId).toBe("reply");
    expect(result[0]?.blocks[0]).toMatchObject({ agentId: "agent", status: "finished" });
    expect(result[1]?.blocks[0]).toMatchObject({ agentId: "agent", status: "finished" });
    expect(result[0]?.blocks[1]).toBe(messages[0]?.blocks[1]);
    expect(result[2]).toBe(messages[2]);
    expect(messages[0]?.blocks[0]).toMatchObject({ status: "running" });
  });

  it("sets reactions only for the supplied message and accepts only literal true", () => {
    const messages = [
      { id: "first", thumbsUp: true, replyToMessageId: "reply" },
      { id: "second", thumbsUp: false },
    ];
    const result = updateMessageReaction(messages, { messageId: "first", thumbsUp: "true" });
    expect(result[0]).toEqual({ ...messages[0], thumbsUp: false });
    expect(result[1]).toBe(messages[1]);
    expect(
      updateMessageReaction(messages, { messageId: "second", thumbsUp: true })[1]?.thumbsUp,
    ).toBe(true);
  });
});
