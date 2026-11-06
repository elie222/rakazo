import type { ProductEvent } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearToolCallRecords,
  liveToolCallRecords,
  recordToolCallEvent,
  subscribeToolCallRecords,
} from "./tool-call-records";

function event(type: ProductEvent["type"], payload: Record<string, unknown>, runId = "run-1") {
  return {
    id: `${type}-${payload.executionId}`,
    spaceId: "space-1",
    threadId: "thread-1",
    botId: "bot-1",
    seq: 1,
    type,
    runId,
    createdAt: "2026-08-16T00:00:01.000Z",
    payload,
  } satisfies ProductEvent;
}

afterEach(() => clearToolCallRecords());

describe("live tool call records", () => {
  it("keeps one record per call of a run and tells subscribers", () => {
    const listener = vi.fn();
    subscribeToolCallRecords(listener);
    recordToolCallEvent(
      event("computer.command", {
        executionId: "x1",
        kind: "shell",
        command: "pnpm test",
        cwd: ".",
        status: "running",
        exitCode: null,
        output: "RUN",
      }),
    );
    const before = liveToolCallRecords("run-1");
    recordToolCallEvent(
      event("agent.tool.completed", { name: "shell", executionId: "x1", outcome: "succeeded" }),
    );
    recordToolCallEvent(event("thread.progress", { text: "…", executionId: "x1" }));
    expect(listener).toHaveBeenCalledTimes(2);
    const after = liveToolCallRecords("run-1");
    expect(after).not.toBe(before);
    expect(after?.get("x1")).toMatchObject({
      status: "running",
      outcome: "succeeded",
      output: "RUN",
    });
    expect(liveToolCallRecords("run-2")).toBeUndefined();
  });

  it("ignores events outside a run", () => {
    recordToolCallEvent({
      ...event("agent.tool.completed", { executionId: "x1" }),
      runId: undefined,
    });
    expect(liveToolCallRecords("run-1")).toBeUndefined();
  });
});
