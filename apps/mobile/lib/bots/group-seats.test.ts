import { describe, expect, it } from "vitest";
import { groupSeatGap, groupSeats, groupSeatsWidth } from "./group-seats";

describe("groupSeats", () => {
  it("seats every member of a group of up to four, in the group's order", () => {
    expect(groupSeats(["a", "b"])).toEqual([
      { kind: "member", member: "a" },
      { kind: "member", member: "b" },
    ]);
    expect(groupSeats(["a", "b", "c", "d"]).map((seat) => seat.kind)).toEqual([
      "member",
      "member",
      "member",
      "member",
    ]);
  });

  it("seats the first three of a bigger group and counts the rest", () => {
    expect(groupSeats(["a", "b", "c", "d", "e"])).toEqual([
      { kind: "member", member: "a" },
      { kind: "member", member: "b" },
      { kind: "member", member: "c" },
      { kind: "more", count: 2 },
    ]);
    expect(groupSeats(Array.from({ length: 10 }, (_, index) => index)).at(-1)).toEqual({
      kind: "more",
      count: 7,
    });
  });

  it("follows a lone member with the group's mark", () => {
    expect(groupSeats(["a"])).toEqual([{ kind: "member", member: "a" }, { kind: "group" }]);
  });

  it("keeps the group's mark as the only seat for a group with no members left", () => {
    expect(groupSeats([])).toEqual([{ kind: "group" }]);
  });
});

describe("groupSeatsWidth", () => {
  it("overlaps each seat by three eighths of the one before it", () => {
    expect([1, 2, 3, 4].map((seats) => groupSeatsWidth(seats))).toEqual([28, 45.5, 63, 80.5]);
    expect(groupSeatsWidth(0)).toBe(0);
  });

  it("cuts a gap of a thirty-sixth of two seats around the seat on top", () => {
    expect(groupSeatGap()).toBeCloseTo(1.556, 3);
  });
});
