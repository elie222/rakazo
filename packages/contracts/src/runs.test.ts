import { describe, expect, it } from "vitest";
import { RunSchema } from "./domain.js";
import { RUN_TRIGGERS, RunActivityRowSchema, RunTriggerSchema } from "./runs.js";

describe("run triggers", () => {
  it("accepts every shared trigger in the run output schemas", () => {
    for (const trigger of RUN_TRIGGERS) {
      expect(RunTriggerSchema.parse(trigger)).toBe(trigger);
      expect(
        RunSchema.parse({
          id: "run-1",
          botId: "bot-1",
          threadId: "thread-1",
          taskId: "task-1",
          status: "running",
          trigger,
          routineId: null,
          modelProvider: null,
          modelId: null,
          error: null,
          startedAt: null,
          completedAt: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        }).trigger,
      ).toBe(trigger);
      expect(
        RunActivityRowSchema.parse({
          runId: "run-1",
          botId: "bot-1",
          botName: "Helper",
          groupId: null,
          groupName: null,
          threadId: "thread-1",
          status: "running",
          trigger,
          notificationsEnabled: false,
          promptSnippet: "",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }).trigger,
      ).toBe(trigger);
    }
  });

  it("includes the ticket trigger and rejects unknown ones", () => {
    expect(RUN_TRIGGERS).toContain("tickets");
    expect(() => RunTriggerSchema.parse("not-a-trigger")).toThrow();
  });
});
