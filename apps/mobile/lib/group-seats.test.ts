import { describe, expect, it } from "vitest";
import {
  groupAvatarTiles,
  groupSeatGap,
  groupSeatsWidth,
  groupTitleSeats,
  groupTitleStatus,
  groupTitleWidth,
} from "./group-seats";

const bot = (name: string, status?: string) => ({ name, status });
const names = (members: ReturnType<typeof groupTitleSeats<{ name: string }>>["seats"]) =>
  members.map((seat) => (seat.kind === "member" ? seat.member.name : "#"));

describe("groupTitleSeats", () => {
  it("shows both members of a pair and three of a trio, with no count", () => {
    expect(groupTitleSeats([bot("a"), bot("b")])).toEqual({
      seats: [
        { kind: "member", member: bot("a") },
        { kind: "member", member: bot("b") },
      ],
      more: 0,
    });
    const trio = groupTitleSeats([bot("a"), bot("b"), bot("c")]);
    expect(names(trio.seats)).toEqual(["a", "b", "c"]);
    expect(trio.more).toBe(0);
  });

  it("shows three of a bigger group and counts the rest", () => {
    const four = groupTitleSeats(["a", "b", "c", "d"].map((name) => bot(name)));
    expect(names(four.seats)).toEqual(["a", "b", "c"]);
    expect(four.more).toBe(1);
    const seven = groupTitleSeats(["a", "b", "c", "d", "e", "f", "g"].map((name) => bot(name)));
    expect(seven.more).toBe(4);
  });

  it("moves the bot that needs the user to the front, ahead of one that is working", () => {
    const { seats } = groupTitleSeats([
      bot("a"),
      bot("b", "running"),
      bot("c"),
      bot("d", "waiting_input"),
    ]);
    expect(names(seats)).toEqual(["d", "b", "a"]);
  });

  it("brings a working bot past the cut into the stack", () => {
    const { seats, more } = groupTitleSeats([
      bot("a"),
      bot("b"),
      bot("c"),
      bot("d"),
      bot("e", "running"),
    ]);
    expect(names(seats)).toEqual(["e", "a", "b"]);
    expect(more).toBe(2);
  });

  it("follows a lone member with the group's mark, and shows the mark alone for nobody", () => {
    expect(names(groupTitleSeats([bot("a")]).seats)).toEqual(["a", "#"]);
    expect(groupTitleSeats([])).toEqual({ seats: [{ kind: "group" }], more: 0 });
  });
});

describe("groupTitleStatus", () => {
  it("names a bot that needs the user ahead of one that is working", () => {
    expect(groupTitleStatus([bot("QA", "running"), bot("Inbox", "waiting_input")])).toEqual({
      kind: "needsYou",
      name: "Inbox",
    });
    expect(groupTitleStatus([bot("QA", "running"), bot("Ops")])).toEqual({
      kind: "working",
      name: "QA",
    });
  });

  it("says nothing while every bot is idle", () => {
    expect(groupTitleStatus([bot("a"), bot("b", "completed")])).toBeNull();
    expect(groupTitleStatus([])).toBeNull();
  });
});

describe("groupTitleWidth", () => {
  it("fills the pane between a circle on each side", () => {
    expect(groupTitleWidth(390, { leading: "circle", trailing: "circle" })).toBe(246);
  });

  it("takes the room of a missing control", () => {
    expect(groupTitleWidth(390, { leading: null, trailing: "circle" })).toBe(302);
    expect(groupTitleWidth(390, { leading: "circle", trailing: null })).toBe(302);
  });

  it("leaves Restore its wider room on an archived chat", () => {
    expect(groupTitleWidth(390, { leading: "circle", trailing: "text" })).toBe(198);
  });
});

describe("groupSeatsWidth", () => {
  it("tucks each 34pt seat 12pt under the one before it", () => {
    expect([1, 2, 3].map((seats) => groupSeatsWidth(seats))).toEqual([34, 56, 78]);
    expect(groupSeatsWidth(0)).toBe(0);
  });

  it("cuts a gap of a thirty-sixth of two seats around the seat on top", () => {
    expect(groupSeatGap()).toBeCloseTo(1.889, 3);
  });
});

describe("groupAvatarTiles", () => {
  const ids = (tiles: ReturnType<typeof groupAvatarTiles<{ name: string }>>) =>
    tiles.map((tile) => (tile.kind === "member" ? tile.member.name : `+${tile.count}`));

  it("sets a pair on the diagonal with the first on top-left", () => {
    expect(groupAvatarTiles([bot("a"), bot("b")], 52)).toEqual([
      { kind: "member", member: bot("a"), left: 0, top: 0, size: 33 },
      { kind: "member", member: bot("b"), left: 19, top: 19, size: 33 },
    ]);
    const small = groupAvatarTiles([bot("a"), bot("b")], 40);
    expect(small.map(({ left, top, size }) => [left, top, size])).toEqual([
      [0, 0, 25],
      [15, 15, 25],
    ]);
  });

  it("sets three as a triangle, one above and two below", () => {
    const tiles = groupAvatarTiles([bot("a"), bot("b"), bot("c")], 52);
    expect(ids(tiles)).toEqual(["a", "b", "c"]);
    expect(tiles.map(({ left, top, size }) => [left, top, size])).toEqual([
      [11, 0, 29],
      [0, 23, 29],
      [23, 23, 29],
    ]);
  });

  it("gives a bigger group's third place to a chip counting everyone not shown", () => {
    const tiles = groupAvatarTiles(
      ["a", "b", "c", "d", "e"].map((name) => bot(name)),
      40,
    );
    expect(ids(tiles)).toEqual(["a", "b", "+3"]);
    expect(tiles.at(-1)).toMatchObject({ kind: "more", left: 18, top: 18, size: 22 });
  });

  it("puts the bot that needs the user, or else a working one, on top", () => {
    expect(ids(groupAvatarTiles([bot("a"), bot("b"), bot("c"), bot("d", "running")], 52))).toEqual([
      "d",
      "a",
      "+2",
    ]);
    expect(
      ids(groupAvatarTiles([bot("a", "running"), bot("b", "waiting_input"), bot("c")], 52)),
    ).toEqual(["b", "a", "c"]);
  });
});
