import { describe, expect, it } from "vitest";
import {
  isEphemeralThreadMessageId,
  reasoningMessageId,
  reasoningToolTitle,
  upsertReasoningStep,
  visibleReasoningSteps,
} from "./reasoning.js";

describe("reasoning helpers", () => {
  it("identifies live progress, reasoning, and pending ids", () => {
    expect(isEphemeralThreadMessageId("progress:run-1")).toBe(true);
    expect(isEphemeralThreadMessageId("reasoning:run-1")).toBe(true);
    expect(isEphemeralThreadMessageId("pending:abc")).toBe(true);
    expect(isEphemeralThreadMessageId("m-1")).toBe(false);
  });

  it("upserts reasoning steps by id", () => {
    const first = upsertReasoningStep([], {
      id: "think",
      kind: "think",
      title: "Thinking",
      status: "running",
    });
    const second = upsertReasoningStep(first, {
      id: "think",
      kind: "think",
      title: "Thinking",
      detail: "considering files",
      status: "running",
    });
    expect(second).toHaveLength(1);
    expect(second[0]?.detail).toBe("considering files");
    expect(reasoningMessageId({ runId: "r1" })).toBe("reasoning:r1");
  });

  it("hides filler status steps from the ChatGPT-style thought body", () => {
    expect(
      visibleReasoningSteps([
        { id: "status", kind: "status", title: "Working through the request", status: "running" },
        { id: "think", kind: "think", title: "Thinking", detail: "checking files", status: "done" },
        { id: "status-done", kind: "status", title: "Finished", status: "done" },
        {
          id: "err",
          kind: "status",
          title: "Gateway error",
          detail: "401: bad key",
          status: "done",
        },
      ]).map((step) => step.id),
    ).toEqual(["think", "err"]);
  });

  it("names common tools in the trace", () => {
    expect(reasoningToolTitle("shell")).toBe("Running a command");
    expect(reasoningToolTitle("write_file", { path: "notes/result.txt" })).toBe(
      "Writing result.txt",
    );
  });
});
