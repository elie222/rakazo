import { readFileSync } from "node:fs";
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

it("lets the chat title open those settings, in groups too", () => {
  const thread = readFileSync(new URL("../app/thread.tsx", import.meta.url), "utf8");
  const start = thread.indexOf("headerTitle: () => (");
  const title = thread.slice(start, thread.indexOf("</Pressable>", start));
  expect(thread).toContain(
    "const titleSettings = chatSettingsRoute({ groupId, botId, readOnly });",
  );
  expect(title).toContain("disabled={!titleSettings}");
  expect(title).toContain("router.push(titleSettings)");
  expect(title).not.toMatch(/disabled=\{[^}]*inGroup/);
});
