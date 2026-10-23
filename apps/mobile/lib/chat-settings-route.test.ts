import { expect, it } from "vitest";
import { chatSettingsRoute } from "./chat-settings-route";

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
