import { describe, expect, it } from "vitest";
import { messagingAudience, messagingAudienceChannelId } from "./messaging-audience.js";

describe("messaging audience", () => {
  const block = {
    kind: "channel_message" as const,
    provider: "fake",
    channelId: "group-1",
    fromAddress: "sender",
    fromLabel: "Sender",
    text: "Hello",
    hop: 0,
  };
  it("requires trusted messaging routing before assigning an external audience", () => {
    expect(messagingAudience("user", [block])).toBeNull();
    expect(messagingAudience("follow_up", [block])).toBeNull();
    expect(messagingAudience("messaging", [block])).toBe("channel:group-1");
    expect(messagingAudience("messaging", [{ kind: "text", text: "Private DM" }])).toBe("dm");
  });
  it("does not treat private or legacy audiences as channels", () => {
    for (const value of [null, undefined, "dm", "channel:"])
      expect(messagingAudienceChannelId(value)).toBeNull();
    expect(messagingAudienceChannelId("channel:group-1")).toBe("group-1");
  });
});
