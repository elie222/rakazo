import { expect, it } from "vitest";
import { memoryEntries } from "./memory-entries";

it("keeps exact offsets for repeated and Unicode lines", () => {
  expect(memoryEntries("one\r\n🙂 same\n🙂 same\n\nlast")).toEqual([
    { start: 0, end: 3, text: "one" },
    { start: 5, end: 12, text: "🙂 same" },
    { start: 13, end: 20, text: "🙂 same" },
    { start: 22, end: 26, text: "last" },
  ]);
});
