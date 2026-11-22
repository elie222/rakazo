import { expect, it } from "vitest";
import { firstThreadRoute } from "./use-shell-navigation";

const now = Date.parse("2026-11-07T12:00:00Z");
const later = "2026-11-08T09:00:00.000Z";

it("lands on a listed chat before a snoozed one", () => {
  expect(firstThreadRoute([{ id: "a", snoozedUntil: later }, { id: "b" }], [], now)).toBe("/app/b");
  expect(firstThreadRoute([{ id: "a", snoozedUntil: later }], [{ id: "g" }], now)).toBe("/app/g/g");
  // With every chat snoozed, still open one rather than none.
  expect(firstThreadRoute([{ id: "a", snoozedUntil: later }], [], now)).toBe("/app/a");
  expect(firstThreadRoute([], [], now)).toBe("/app");
});

it("never lands on a hidden chat, even with nothing else to open", () => {
  expect(firstThreadRoute([{ id: "a", hidden: true }, { id: "b" }], [], now)).toBe("/app/b");
  expect(firstThreadRoute([{ id: "a", hidden: true }], [{ id: "g" }], now)).toBe("/app/g/g");
  expect(firstThreadRoute([{ id: "a", hidden: true }], [{ id: "g", hidden: true }], now)).toBe(
    "/app",
  );
  // A snoozed chat still opens before none, but not over being hidden.
  expect(
    firstThreadRoute(
      [
        { id: "a", hidden: true },
        { id: "b", snoozedUntil: later },
      ],
      [],
      now,
    ),
  ).toBe("/app/b");
});
