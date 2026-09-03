import { describe, expect, it } from "vitest";
import {
  isMessagingChannelRun,
  messagingChannelPrivacyBlock,
  messagingDmSurfaceNote,
} from "./messaging-prompts.js";

describe("messagingDmSurfaceNote", () => {
  it("explains the shared messaging conversation and conciseness", () => {
    const note = messagingDmSurfaceNote();
    expect(note).toMatch(/messaging app/);
    expect(note).toMatch(/iMessage/);
    expect(note).toMatch(/same (thread|conversation)/i);
    expect(note).toMatch(/concise/i);
  });
});

describe("messagingChannelPrivacyBlock", () => {
  it("forbids leaking owner data and allows silent finishes", () => {
    const block = messagingChannelPrivacyBlock();
    expect(block).toMatch(/never (reveal|share)/i);
    expect(block).toMatch(/personal information/i);
    expect(block).toMatch(/memory/i);
    expect(block).toMatch(/1:1/);
    expect(block).toMatch(/attributed/i);
    expect(block).toMatch(/silent/i);
  });
});

describe("isMessagingChannelRun", () => {
  const channelBlock = {
    kind: "channel_message" as const,
    provider: "sendblue",
    channelId: "ch-1",
    fromAddress: "+15551234567",
    fromLabel: "Alice",
    text: "hi",
  };

  it("detects channel runs from the source message blocks", () => {
    expect(isMessagingChannelRun("messaging", [channelBlock])).toBe(true);
    expect(isMessagingChannelRun("messaging", [{ kind: "text", text: "hi" }])).toBe(false);
    expect(isMessagingChannelRun("user", [channelBlock])).toBe(false);
    expect(isMessagingChannelRun("messaging", undefined)).toBe(false);
  });
});
