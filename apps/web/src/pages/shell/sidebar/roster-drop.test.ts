import { GROUP_MEMBER_MAX } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { resolveRosterDrop, rosterDropSlots } from "./roster-drop";

const bot = (id: string, sectionId: string | null, pinned = false) => ({
  id,
  sectionId,
  pinned,
});
const group = (id: string, sectionId: string | null, memberIds: string[]) => ({
  id,
  sectionId,
  memberIds,
});

describe("resolveRosterDrop", () => {
  it("reorders when the bot is dropped on a sibling in the same section", () => {
    expect(
      resolveRosterDrop({
        dragged: bot("a", "s1"),
        target: { kind: "bot", chat: bot("b", "s1") },
        sameList: true,
      }),
    ).toEqual({ action: "reorder", targetBotId: "b" });
  });

  it("refuses a reorder across tree levels inside one section", () => {
    expect(
      resolveRosterDrop({
        dragged: bot("a", "s1"),
        target: { kind: "bot", chat: bot("b", "s1") },
        sameList: false,
      }),
    ).toBeNull();
  });

  it("moves to the target bot's section when the sections differ", () => {
    expect(
      resolveRosterDrop({
        dragged: bot("a", "s1"),
        target: { kind: "bot", chat: bot("b", "s2") },
        sameList: false,
      }),
    ).toEqual({ action: "move", sectionId: "s2" });
    expect(
      resolveRosterDrop({
        dragged: bot("a", "s1"),
        target: { kind: "bot", chat: bot("b", null) },
        sameList: false,
      }),
    ).toEqual({ action: "move", sectionId: null });
  });

  it("moves to a section header, including Unassigned", () => {
    expect(
      resolveRosterDrop({
        dragged: bot("a", null),
        target: { kind: "section", sectionId: "s2" },
        sameList: false,
      }),
    ).toEqual({ action: "move", sectionId: "s2" });
    expect(
      resolveRosterDrop({
        dragged: bot("a", "s1"),
        target: { kind: "section", sectionId: null },
        sameList: false,
      }),
    ).toEqual({ action: "move", sectionId: null });
  });

  it("does nothing when dropped on the header of its own section", () => {
    expect(
      resolveRosterDrop({
        dragged: bot("a", "s1"),
        target: { kind: "section", sectionId: "s1" },
        sameList: false,
      }),
    ).toBeNull();
  });

  it("never moves a pinned bot into a section; pinned rows only reorder", () => {
    expect(
      resolveRosterDrop({
        dragged: bot("a", null, true),
        target: { kind: "section", sectionId: "s2" },
        sameList: false,
      }),
    ).toBeNull();
    expect(
      resolveRosterDrop({
        dragged: bot("a", null, true),
        target: { kind: "bot", chat: bot("b", "s2") },
        sameList: false,
      }),
    ).toBeNull();
  });

  it("joins a group chat when dropped on it", () => {
    expect(
      resolveRosterDrop({
        dragged: bot("a", "s1"),
        target: { kind: "group", chat: group("g1", null, ["b", "c"]) },
        sameList: false,
      }),
    ).toEqual({ action: "join", groupId: "g1", botIds: ["b", "c", "a"] });
  });

  it("refuses to join a group it already belongs to or one that is full", () => {
    expect(
      resolveRosterDrop({
        dragged: bot("a", null),
        target: { kind: "group", chat: group("g1", null, ["a", "b"]) },
        sameList: false,
      }),
    ).toBeNull();
    expect(
      resolveRosterDrop({
        dragged: bot("z", null),
        target: {
          kind: "group",
          chat: group(
            "g1",
            null,
            Array.from({ length: GROUP_MEMBER_MAX }, (_, i) => `m${i}`),
          ),
        },
        sameList: false,
      }),
    ).toBeNull();
  });

  it("ignores a drop on itself", () => {
    expect(
      resolveRosterDrop({
        dragged: bot("a", "s1"),
        target: { kind: "bot", chat: bot("a", "s1") },
        sameList: true,
      }),
    ).toBeNull();
  });
});

describe("rosterDropSlots", () => {
  const chat = (id: string, spaceId: string, sectionId: string | null = null) => ({
    id,
    spaceId,
    sectionId,
    pinned: false,
  });
  const slots = rosterDropSlots(
    [
      {
        key: "space:a:section:s1",
        spaceId: "a",
        sectionId: "s1",
        bots: [
          { kind: "bot", chat: chat("a1", "a", "s1") },
          { kind: "bot", chat: chat("a2", "a", "s1") },
          { kind: "group", chat: { id: "g1", spaceId: "a", members: [{ botId: "a1" }] } },
        ],
      },
      { key: "space:a:unassigned", spaceId: "a", sectionId: null, bots: [] },
      {
        key: "space:b:unassigned",
        spaceId: "b",
        sectionId: null,
        bots: [{ kind: "bot", chat: chat("b1", "b") }],
      },
      { key: "space:c:empty", spaceId: "c", sectionId: null, emptySpaceId: "c", bots: [] },
    ],
    "a",
  );

  it("keys every row and header with what it takes in the active Space", () => {
    expect(slots.get("header:space:a:section:s1")).toEqual({
      spaceId: "a",
      target: { kind: "section", sectionId: "s1" },
      groupBotIds: ["a1", "a2"],
      header: true,
    });
    expect(slots.get("header:space:a:unassigned")?.target).toEqual({
      kind: "section",
      sectionId: null,
    });
    expect(slots.get("row:bot:a2")).toEqual({
      spaceId: "a",
      target: { kind: "bot", chat: chat("a2", "a", "s1") },
      groupBotIds: ["a1", "a2"],
      header: false,
    });
    expect(slots.get("row:group:g1")?.target).toEqual({
      kind: "group",
      chat: { id: "g1", memberIds: ["a1"] },
    });
  });

  it("names other Spaces' rows and headers but takes no drop there", () => {
    expect(slots.get("row:bot:b1")).toMatchObject({ spaceId: "b", target: null });
    expect(slots.get("header:space:b:unassigned")).toMatchObject({ spaceId: "b", target: null });
    expect(slots.get("header:space:c:empty")).toMatchObject({ spaceId: "c", target: null });
  });
});
