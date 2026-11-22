import type { SearchHit, SpaceBot, SpaceGroup } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import type { InboxSpace } from "../inbox/inbox-spaces";
import { searchSheetRows } from "./search-sheet";

const common = {
  spaceId: "space-1",
  pinned: false,
  sectionId: null,
  unread: false,
  updatedAt: "2026-01-01T00:00:00Z",
};
const bot: SpaceBot = {
  ...common,
  id: "bot-1",
  name: "Café helper",
  title: "",
  preview: "Daily re\u0301sume\u0301",
  color: "gray",
  notifyOnFinish: false,
  parentBotId: null,
  status: "idle",
  runErrorId: null,
};
const group: SpaceGroup = {
  ...common,
  id: "group-1",
  name: "Cafe\u0301 team",
  preview: "Weekly résumé",
  members: [],
};
const spaces: InboxSpace[] = [
  {
    id: common.spaceId,
    name: "Example",
    isDefault: true,
    hasContent: true,
    botSections: [],
    bots: [bot],
    groups: [group],
  },
];

describe("instant mobile roster search", () => {
  it.each(["café", "CAFE\u0301", "  Café  "])(
    "finds both accent spellings without changing their display or destination (%j)",
    (query) => {
      const rows = searchSheetRows(spaces, query, []);
      expect(rows.map((row) => row.title)).toEqual([bot.name, group.name]);
      expect(rows.map((row) => row.destination)).toEqual([
        { pathname: "/thread", params: { botId: bot.id, name: bot.name } },
        { pathname: "/group-thread", params: { groupId: group.id, name: group.name } },
      ]);
    },
  );

  it("matches equivalent accents in previews while keeping their original text", () => {
    const rows = searchSheetRows(spaces, "RÉSUMÉ", []);
    expect(rows.map((row) => row.preview)).toEqual([bot.preview, group.preview]);
  });

  it("does not strip accents or change ordinary substring matching", () => {
    expect(searchSheetRows(spaces, "cafe", [])).toEqual([]);
    expect(searchSheetRows(spaces, "team", []).map((row) => row.key)).toEqual(["group-group-1"]);
    expect(searchSheetRows(spaces, "helper daily", []).map((row) => row.key)).toEqual([
      "bot-bot-1",
    ]);
  });

  it("still omits remote hits for blank queries and dedupes them against local chat rows", () => {
    const hits: SearchHit[] = [
      { kind: "conversation", botId: bot.id, title: "Remote bot", snippet: "" },
      { kind: "message", botId: bot.id, title: "Remote message", snippet: "", messageId: "msg-1" },
    ];
    expect(searchSheetRows(spaces, "  ", hits).map((row) => row.title)).toEqual([
      bot.name,
      group.name,
    ]);
    expect(searchSheetRows(spaces, "café", hits).map((row) => row.title)).toEqual([
      bot.name,
      group.name,
      "Remote message",
    ]);
  });
});
