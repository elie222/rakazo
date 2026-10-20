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
          agentMessage: null,
          promptSnippet: "",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }).trigger,
      ).toBe(trigger);
    }
  });
});

describe("activity message metadata", () => {
  const row = {
    runId: "run-1",
    botId: "bot-1",
    botName: "Helper",
    groupId: null,
    groupName: null,
    threadId: "thread-1",
    status: "running",
    trigger: "bot_message",
    notificationsEnabled: false,
    promptSnippet: "Ready",
    updatedAt: "2026-01-01T00:00:00Z",
  };
  it("requires nullable metadata and validates its kind", () => {
    expect(RunActivityRowSchema.safeParse(row).success).toBe(false);
    expect(RunActivityRowSchema.safeParse({ ...row, agentMessage: null }).success).toBe(true);
    expect(
      RunActivityRowSchema.parse({ ...row, agentMessage: { fromBotName: "", kind: "update" } })
        .agentMessage,
    ).toEqual({ fromBotName: "", kind: "update" });
    expect(
      RunActivityRowSchema.safeParse({
        ...row,
        agentMessage: { fromBotName: "Peer", kind: "invalid" },
      }).success,
    ).toBe(false);
  });
});
