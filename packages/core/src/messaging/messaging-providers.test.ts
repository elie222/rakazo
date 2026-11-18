import { describe, expect, it } from "vitest";
import {
  availableChatApps,
  isAvailableChatApp,
  messagingChatApps,
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
    expect(messagingProviderName("teams")).toBe("Microsoft Teams");
    expect(messagingProviderName("signal")).toBe("signal");
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

describe("messaging chat apps", () => {
  const identities = [
    { provider: "telegram", botId: "bot-1" },
    { provider: "slack", botId: "bot-2" },
    { provider: "signal", botId: "bot-3" },
  ];
  const bots = [{ id: "bot-1" }, { id: "bot-2" }, { id: "bot-4" }];

  it("lists Slack once, beside its workspaces, even when it also links with a code", () => {
    const apps = messagingChatApps({
      providers: ["slack", "telegram"],
      installAvailable: false,
      installations: [{ provider: "slack" }],
      identities,
      bots,
    });
    expect(apps).toMatchObject({
      slackInstall: false,
      showSlack: true,
      linkProviders: ["telegram"],
    });
    expect(apps.otherIdentities).toEqual([{ provider: "signal", botId: "bot-3" }]);
  });

  it("offers only bots not already answering a chat app", () => {
    const apps = messagingChatApps({
      providers: ["telegram"],
      installAvailable: false,
      installations: [],
      identities,
      bots,
    });
    expect(apps.freeBots).toEqual([{ id: "bot-4" }]);
    expect(apps.otherIdentities.map(({ provider }) => provider)).toEqual(["slack", "signal"]);
  });
});
