import { describe, expect, it } from "vitest";
import { hasModelAccess } from "./billing.js";

describe("model access", () => {
  const now = new Date("2030-01-15T12:00:00.000Z");
  const later = new Date("2030-02-14T12:00:00.000Z");
  it.each([
    { mode: null, balanceMicros: 0n, byokFreeUntil: null, status: null, access: false },
    { mode: "byok", balanceMicros: 0n, byokFreeUntil: later, status: null, access: true },
    { mode: "byok", balanceMicros: 0n, byokFreeUntil: now, status: null, access: false },
    { mode: "byok", balanceMicros: 0n, byokFreeUntil: null, status: "active", access: true },
    // A top-up does not pay for running your own key.
    { mode: "byok", balanceMicros: 5n, byokFreeUntil: null, status: null, access: false },
    { mode: "credits", balanceMicros: 5n, byokFreeUntil: null, status: null, access: true },
    { mode: null, balanceMicros: 5n, byokFreeUntil: null, status: null, access: true },
    // Spent credits do not leave own-key runs on other providers free.
    { mode: "credits", balanceMicros: 0n, byokFreeUntil: null, status: null, access: false },
    { mode: "credits", balanceMicros: 0n, byokFreeUntil: null, status: "canceled", access: false },
  ])("$mode with balance $balanceMicros and $status: $access", ({ status, access, ...credits }) => {
    expect(hasModelAccess(credits, status, now)).toBe(access);
  });
});
