import { describe, expect, it } from "vitest";
import { appContract } from "../rpc/app-contract.js";
import { CreateRoutineInput } from "./routine.js";

describe("routine name and instruction bounds", () => {
  const update = appContract.routines.update["~orpc"].inputSchema!;
  const create = { botId: "bot-1", name: "Daily", prompt: "Check", crons: ["0 9 * * *"] };

  it("rejects an empty name on update and a name over 80 characters on create", () => {
    expect(update.safeParse({ routineId: "routine-1", name: "" }).success).toBe(false);
    expect(CreateRoutineInput.safeParse({ ...create, name: "" }).success).toBe(false);
    expect(CreateRoutineInput.safeParse({ ...create, name: "x".repeat(81) }).success).toBe(false);
  });

  it("still saves an existing routine whose name a bot made longer than 80 characters", () => {
    expect(update.safeParse({ routineId: "routine-1", name: "x".repeat(200) }).success).toBe(true);
  });

  it("accepts a name of exactly 80 characters on create", () => {
    expect(CreateRoutineInput.safeParse({ ...create, name: "x".repeat(80) }).success).toBe(true);
  });

  it("rejects an empty instruction on update, as create does", () => {
    expect(CreateRoutineInput.safeParse({ ...create, prompt: "" }).success).toBe(false);
    expect(update.safeParse({ routineId: "routine-1", prompt: "" }).success).toBe(false);
  });

  it("leaves name and instruction optional on update", () => {
    expect(update.safeParse({ routineId: "routine-1", active: false }).success).toBe(true);
    expect(update.parse({ routineId: "routine-1", name: "Renamed" }).prompt).toBeUndefined();
  });
});
