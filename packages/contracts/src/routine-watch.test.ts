import { describe, expect, it } from "vitest";
import { RoutineWatchSchema } from "./routine-watch.js";

describe("watch intervals", () => {
  it.each([
    { kind: "files", paths: ["inbox"] },
    { kind: "command", command: "echo changed" },
    { kind: "tool", tool: "read_changes" },
  ])("requires at least five minutes for $kind", (watch) => {
    expect(RoutineWatchSchema.safeParse({ ...watch, everyMinutes: 4 }).success).toBe(false);
    expect(RoutineWatchSchema.safeParse({ ...watch, everyMinutes: 5 }).success).toBe(true);
    expect(RoutineWatchSchema.parse(watch).everyMinutes).toBe(15);
  });
});
