// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { appBotInboundUrl } from "./inbound-url";

describe("appBotInboundUrl", () => {
  it("uses the deployment's published inbound origin when it has one", () => {
    expect(appBotInboundUrl("https://hooks.example.test/", "bot_1", "webhook")).toBe(
      "https://hooks.example.test/api/v1/bots/bot_1/webhook",
    );
    expect(appBotInboundUrl("https://hooks.example.test", "bot_1", "github")).toBe(
      "https://hooks.example.test/api/v1/bots/bot_1/github",
    );
  });

  it("falls back to the server this app talks to", () => {
    expect(appBotInboundUrl(undefined, "bot_1", "webhook")).toBe(
      `${window.location.origin}/api/v1/bots/bot_1/webhook`,
    );
  });
});
