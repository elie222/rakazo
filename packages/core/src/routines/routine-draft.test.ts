import { describe, expect, it } from "vitest";
import {
  defaultRoutineEndDay,
  draftFromRoutine,
  formatRoutineEnd,
  routineComputerUpdate,
  routineCopy,
  routineEndUpdate,
} from "./routine-draft.js";

describe("routineComputerUpdate", () => {
  const on = { useComputer: true, name: "Backups", prompt: "Check the backups" };
  const next = (changes: Partial<Parameters<typeof routineComputerUpdate>[1]> = {}) => ({
    useComputer: undefined,
    name: on.name,
    prompt: on.prompt,
    eventTriggered: false,
    ...changes,
  });

  it("approves again the prompt shown when a save edits the prompt or name while it is on", () => {
    expect(routineComputerUpdate(on, next({ prompt: "Check the backups twice" }))).toEqual({
      useComputer: true,
      prompt: "Check the backups twice",
    });
    expect(routineComputerUpdate(on, next({ name: "Nightly" }))).toEqual({
      useComputer: true,
      prompt: on.prompt,
    });
    expect(routineComputerUpdate(on, next({ useComputer: true }))).toEqual({});
    // Off, an edit is only an edit.
    expect(
      routineComputerUpdate({ ...on, useComputer: false }, next({ prompt: "Something else" })),
    ).toEqual({});
  });

  it("sends a flip, with the prompt shown when turning it on", () => {
    expect(
      routineComputerUpdate({ ...on, useComputer: false }, next({ useComputer: true })),
    ).toEqual({ useComputer: true, prompt: on.prompt });
    expect(routineComputerUpdate(on, next({ useComputer: false, prompt: "Other" }))).toEqual({
      useComputer: false,
    });
  });

  it("sends nothing where the server would refuse it or never offered it", () => {
    expect(routineComputerUpdate(on, next({ prompt: "Other", eventTriggered: true }))).toEqual({});
    expect(
      routineComputerUpdate({ ...on, useComputer: undefined }, next({ useComputer: true })),
    ).toEqual({});
  });
});

describe("routine end in an editor", () => {
  const routine = {
    name: "Deals",
    prompt: "Check the deals",
    crons: ["0 9 * * *"],
    emailSenders: null,
    active: true,
    timezone: "America/New_York",
    endsAt: "2026-11-30T23:00:00.000Z",
  };

  it("opens on the day the end falls on in the routine's timezone", () => {
    expect(draftFromRoutine(routine).endsOn).toBe("2026-11-30");
  });

  it("keeps a time a bot set, on the same day or a new one", () => {
    expect(routineEndUpdate(routine, "2026-11-30", true)).toEqual({});
    expect(routineEndUpdate(routine, "2026-12-02", true)).toEqual({
      endsAt: "2026-12-02T23:00:00.000Z",
    });
  });

  it("ends a newly picked day at its last moment", () => {
    expect(routineEndUpdate({ ...routine, endsAt: null }, "2026-12-02", true)).toEqual({
      endsAt: "2026-12-03T04:59:59.999Z",
    });
  });

  it("clears the end when the day is cleared or nothing repeats", () => {
    expect(routineEndUpdate(routine, "", true)).toEqual({ endsAt: null });
    expect(routineEndUpdate(routine, "2026-11-30", false)).toEqual({ endsAt: null });
    expect(routineEndUpdate({ ...routine, endsAt: null }, "", true)).toEqual({});
  });

  it("copies an end still ahead and drops one that has passed", () => {
    const now = Date.parse("2026-11-29T00:00:00.000Z");
    expect(routineCopy(routine, "Deals (copy)", now)?.endsAt).toBe(routine.endsAt);
    expect(
      routineCopy(routine, "Deals (copy)", Date.parse("2026-12-01T00:00:00.000Z")),
    ).toMatchObject({ endsAt: null, active: false });
  });

  it("suggests a week ahead, or the next run when that comes later", () => {
    const now = new Date("2026-11-23T12:00:00.000Z");
    expect(defaultRoutineEndDay(["0 9 * * *"], "UTC", now)).toBe("2026-11-30");
    expect(defaultRoutineEndDay(["0 9 15 * *"], "UTC", now)).toBe("2026-12-15");
  });

  it("names the time only when the routine ends before its day is over", () => {
    const year = new Date().getUTCFullYear();
    expect(formatRoutineEnd(`${year}-06-30T23:59:59.999Z`, "UTC", "en-US")).toBe("Jun 30");
    expect(formatRoutineEnd(`${year}-06-30T18:00:00.000Z`, "UTC", "en-US")).toMatch(
      /^Jun 30, 6:00\sPM$/,
    );
  });
});
