import { expect, it } from "vitest";
import { chatSettingsRoute, chatTitleRoute } from "./chat-settings-route";

it("opens the group's settings from a group chat and the bot's from a one-to-one chat", () => {
  expect(chatSettingsRoute({ groupId: "group-1", botId: "bot-1" })).toEqual({
    pathname: "/group-settings",
    params: { groupId: "group-1" },
  });
  expect(chatSettingsRoute({ botId: "bot-1" })).toEqual({
    pathname: "/bot-settings",
    params: { botId: "bot-1" },
  });
  expect(chatSettingsRoute({ groupId: "group-1", readOnly: true })).toBeNull();
  expect(chatSettingsRoute({})).toBeNull();
});

it("opens a one-to-one chat's bot profile, and a group's settings, from the title", () => {
  expect(chatTitleRoute({ botId: "bot-1", name: "Helper" })).toEqual({
    pathname: "/bot-profile",
    params: { botId: "bot-1", name: "Helper" },
  });
  expect(chatTitleRoute({ botId: "bot-1" })).toEqual({
    pathname: "/bot-profile",
    params: { botId: "bot-1", name: "" },
  });
  expect(chatTitleRoute({ groupId: "group-1", botId: "bot-1", name: "Team" })).toEqual({
    pathname: "/group-settings",
    params: { groupId: "group-1" },
  });
  expect(chatTitleRoute({ botId: "bot-1", name: "Helper", readOnly: true })).toBeNull();
  expect(chatTitleRoute({})).toBeNull();
});
