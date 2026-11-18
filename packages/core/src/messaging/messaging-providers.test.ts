import { describe, expect, it } from "vitest";
import {
  availableChatApps,
  isAvailableChatApp,
  messagingConnectOptions,
  messagingProviderLabel,
  messagingProviderName,
  messagingProviderNamed,
} from "./messaging-providers.js";

describe("messaging provider labels", () => {
  it("names known providers and falls back to the raw id", () => {
    expect(messagingProviderName("sendblue")).toBe("iMessage");
    expect(messagingProviderName("telegram")).toBe("Telegram");
    expect(messagingProviderName("photon")).toBe("iMessage (Photon)");
    expect(messagingProviderName("teams")).toBe("teams");
  });

  it("finds a provider a user names by its id or its name", () => {
    expect(messagingProviderNamed("Slack", ["telegram", "slack"])).toBe("slack");
    expect(messagingProviderNamed("imessage", ["sendblue"])).toBe("sendblue");
    expect(messagingProviderNamed("slack", ["telegram"])).toBeNull();
    expect(messagingProviderNamed(" ", ["slack"])).toBeNull();
  });

  it("names extra Telegram bots after their configured name", () => {
    expect(messagingProviderName("telegram-work")).toBe("Telegram (work)");
    expect(messagingProviderLabel("telegram-work")).toBe("Telegram (work)");
  });

  it("names extra Photon projects after their configured name", () => {
    expect(messagingProviderName("photon-pm")).toBe("iMessage (pm)");
    expect(messagingProviderLabel("photon-pm")).toBe("iMessage (pm)");
  });

  it("narrows iMessage to its transport", () => {
    expect(messagingProviderLabel("sendblue", "SMS")).toBe("SMS");
    expect(messagingProviderLabel("sendblue", "fax")).toBe("iMessage");
  });
});

it("offers Slack authorization once, including before a workspace is installed", () => {
  expect(messagingConnectOptions(["slack", "telegram", "slack"], true)).toEqual([
    { provider: "slack", method: "install" },
    { provider: "telegram", method: "link" },
  ]);
  expect(messagingConnectOptions([], true)).toEqual([{ provider: "slack", method: "install" }]);
  expect(messagingConnectOptions(["slack"], false)).toEqual([
    { provider: "slack", method: "link" },
  ]);
});

it("recognizes a catalog app that is also a chat app people can connect here", () => {
  const chatApps = availableChatApps(["telegram"], true);
  expect(chatApps).toEqual(["telegram", "slack"]);
  expect(isAvailableChatApp({ name: "Slack", slug: "SLACK" }, chatApps)).toBe(true);
  expect(isAvailableChatApp({ name: "Telegram Bot", slug: "telegram" }, chatApps)).toBe(true);
  expect(isAvailableChatApp({ name: "Notion", slug: "notion" }, chatApps)).toBe(false);
  expect(isAvailableChatApp({ name: "Slack", slug: "slack" }, [])).toBe(false);
  expect(isAvailableChatApp({ name: "Telegram", slug: "tg" }, ["telegram-work"])).toBe(true);
});
