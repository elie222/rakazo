import { describe, expect, it } from "vitest";
import { routineComputerUpdate } from "./routine-draft.js";

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
