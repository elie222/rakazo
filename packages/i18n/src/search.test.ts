import { expect, it } from "vitest";
import { searchKindLabel } from "./search.js";

const message = {
  kind: "message" as const,
  botId: "bot-a",
  botName: "Scout",
  title: "Found note",
  snippet: "A **matching** line",
  messageId: "message-a",
};

it.each([
  ["conversation", "Bot"],
  ["message", "Message"],
  ["file", "File"],
  ["link", "Link"],
  ["routine", "Routine"],
] as const)("labels %s hits", (kind, label) => {
  expect(searchKindLabel({ ...message, kind })).toBe(label);
});

it("labels a group conversation as a group", () => {
  expect(searchKindLabel({ ...message, kind: "conversation", groupId: "group-a" })).toBe("Group");
});
