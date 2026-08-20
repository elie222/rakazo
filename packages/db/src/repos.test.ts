import { describe, expect, it } from "vitest";
import { mapBot } from "./repos.js";

const baseBot = {
  id: "bot-1",
  workspaceId: "ws-1",
  name: "Test Bot",
  title: "",
  description: "",
  instructions: "",
  color: "#000",
  notifyOnFinish: true,
  pinned: false,
  archivedAt: null,
  parentBotId: null,
  memoryScope: null as string | null,
  createdAt: new Date("2026-08-19T00:00:00.000Z"),
  updatedAt: new Date("2026-08-19T00:00:00.000Z"),
  thread: { id: "thread-1", unread: false },
  computer: null,
};

describe("mapBot", () => {
  it("passes memoryScope through as null when unset", () => {
    expect(mapBot(baseBot).memoryScope).toBeNull();
  });

  it("passes memoryScope through when set to shared", () => {
    expect(mapBot({ ...baseBot, memoryScope: "shared" }).memoryScope).toBe("shared");
  });
});
