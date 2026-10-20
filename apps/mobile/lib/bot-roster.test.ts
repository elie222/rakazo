import type { Bot } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import type { MobileBot } from "./api";
import { retainUnchangedBotRoster } from "./bot-roster";

function bot(id = "bot-1"): Bot {
  return {
    id,
    name: "Helper",
    preview: "",
    title: "",
    color: "gray",
    notifyOnFinish: true,
    threadId: `thread-${id}`,
    pinned: false,
    status: "idle",
    runErrorId: null,
    sectionId: null,
    archivedAt: null,
    unread: false,
    updatedAt: "2026-01-01T00:00:00.000Z",
    computerMode: "team",
    modelProvider: null,
    modelId: null,
    thinkingLevel: null,
    autoSpeak: false,
    spaceId: "space-1",
    description: "",
    instructions: "",
    parentBotId: null,
    memoryScope: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    voiceId: null,
    teamChatAmbientEnabled: false,
    teamChatRules: "",
    fleetManagement: false,
    disabledBuiltinTools: [],
    webhookConfigured: false,
    spawnKey: null,
  };
}

describe("thread bot roster", () => {
  it.each([{ disabledBuiltinTools: [] }, { disabledBuiltinTools: ["web_search", "shell"] }])(
    "retains full server responses with unchanged disabled tools %j",
    ({ disabledBuiltinTools }) => {
      const current = [{ ...bot(), disabledBuiltinTools }];
      const next = JSON.parse(JSON.stringify(current)) as Bot[];
      expect(next[0]!.disabledBuiltinTools).not.toBe(current[0]!.disabledBuiltinTools);
      expect(retainUnchangedBotRoster(current, next)).toBe(current);
    },
  );

  it("applies disabled tool content, length and ordering changes", () => {
    const current = [{ ...bot(), disabledBuiltinTools: ["web_search", "shell"] }];
    for (const disabledBuiltinTools of [
      ["web_search", "read_file"],
      ["web_search"],
      ["shell", "web_search"],
      [],
    ]) {
      const next = [{ ...bot(), disabledBuiltinTools }];
      expect(retainUnchangedBotRoster(current, next)).toBe(next);
      expect(retainUnchangedBotRoster(next, current)).toBe(current);
    }
  });

  it("retains identical RPC data, including differently ordered object keys", () => {
    const current = [bot()];
    const next = [{ ...current[0]!, name: "Helper" }];
    const reordered = [Object.fromEntries(Object.entries(next[0]!).reverse()) as MobileBot];
    expect(retainUnchangedBotRoster(current, next)).toBe(current);
    expect(retainUnchangedBotRoster(current, reordered)).toBe(current);
    const empty: MobileBot[] = [];
    expect(retainUnchangedBotRoster(empty, [])).toBe(empty);
  });

  it("applies field, optional field, membership and ordering changes", () => {
    const current = [bot(), bot("bot-2")];
    for (const next of [
      [{ ...current[0]!, autoSpeak: true }, current[1]!],
      [{ ...current[0]!, name: "Renamed" }, current[1]!],
      [{ ...current[0]!, parentBotId: "parent" }, current[1]!],
      current.slice(1),
      [...current].reverse(),
      [],
    ]) {
      expect(retainUnchangedBotRoster(current, next)).toBe(next);
      expect(retainUnchangedBotRoster(next, current)).toBe(current);
    }
  });
});
