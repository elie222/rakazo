import { describe, expect, it } from "vitest";
import {
  isPhoneChannelRun,
  phoneChannelPrivacyBlock,
  phoneDmSurfaceNote,
} from "./phone-prompts.js";

describe("phoneDmSurfaceNote", () => {
  it("explains the shared iMessage conversation and conciseness", () => {
    const note = phoneDmSurfaceNote();
    expect(note).toMatch(/iMessage/);
    expect(note).toMatch(/same (thread|conversation)/i);
    expect(note).toMatch(/concise/i);
  });
});

describe("phoneChannelPrivacyBlock", () => {
  it("forbids leaking owner data and allows silent finishes", () => {
    const block = phoneChannelPrivacyBlock();
    expect(block).toMatch(/never (reveal|share)/i);
    expect(block).toMatch(/personal information/i);
    expect(block).toMatch(/memory/i);
    expect(block).toMatch(/1:1/);
    expect(block).toMatch(/attributed/i);
    expect(block).toMatch(/silent/i);
  });
});

describe("isPhoneChannelRun", () => {
  const channelBlock = {
    kind: "phone_channel_message" as const,
    channelId: "ch-1",
    fromNumber: "+15551234567",
    fromLabel: "Alice",
    text: "hi",
  };

  it("detects channel runs from the source message blocks", () => {
    expect(isPhoneChannelRun("phone", [channelBlock])).toBe(true);
    expect(isPhoneChannelRun("phone", [{ kind: "text", text: "hi" }])).toBe(false);
    expect(isPhoneChannelRun("user", [channelBlock])).toBe(false);
    expect(isPhoneChannelRun("phone", undefined)).toBe(false);
  });
});
