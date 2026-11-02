import { expect, it } from "vitest";
import { memoryLineSelection } from "./memory-selection";

it("maps a browser selection back to the exact CRLF and Unicode line", () => {
  expect(
    memoryLineSelection("first\r\n🙂 target\r\nlast", "first\n🙂 target\nlast", 9, 13),
  ).toEqual({ start: 7, end: 16, expected: "🙂 target" });
});

it("rejects a selection across lines or a mismatched draft", () => {
  expect(memoryLineSelection("one\ntwo", "one\ntwo", 1, 5)).toBeNull();
  expect(memoryLineSelection("one\ntwo", "changed", 0, 3)).toBeNull();
});
