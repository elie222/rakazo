import { describe, expect, it } from "vitest";
import { messagingProviderLabel, messagingProviderName } from "./messaging-providers.js";

describe("messaging provider labels", () => {
  it("names known providers and falls back to the raw id", () => {
    expect(messagingProviderName("sendblue")).toBe("iMessage");
    expect(messagingProviderName("telegram")).toBe("Telegram");
    expect(messagingProviderName("teams")).toBe("teams");
  });

  it("names extra Telegram bots after their configured name", () => {
    expect(messagingProviderName("telegram-work")).toBe("Telegram (work)");
    expect(messagingProviderLabel("telegram-work")).toBe("Telegram (work)");
  });

  it("narrows iMessage to its transport", () => {
    expect(messagingProviderLabel("sendblue", "SMS")).toBe("SMS");
    expect(messagingProviderLabel("sendblue", "fax")).toBe("iMessage");
  });
});
