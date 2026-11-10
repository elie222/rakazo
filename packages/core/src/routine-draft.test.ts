import { expect, it } from "vitest";
import { routineOffersSilent } from "./routine-draft.js";

it("offers Silent only to a routine that starts its own runs, or one already silent", () => {
  const none = { silent: false, schedules: [], watch: null };
  expect(routineOffersSilent(none)).toBe(false);
  expect(routineOffersSilent({ ...none, schedules: ["daily"] })).toBe(true);
  expect(routineOffersSilent({ ...none, watch: { everyMinutes: 15 } })).toBe(true);
  // Turned on before its schedule was removed, it can still be turned off.
  expect(routineOffersSilent({ ...none, silent: true })).toBe(true);
});
