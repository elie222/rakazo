import { describe, expect, it } from "vitest";
import { toComputerStatus } from "./computer-status.js";

describe("toComputerStatus", () => {
  it("only marks control that is bound to a waiting run as a requested takeover", () => {
    const computer = {
      kind: "fake",
      state: "running",
      scope: "team",
      controlHolder: "user",
      controlBotId: "bot-1",
      controlRunId: "run-1",
      homeRevision: "revision-1",
    };

    expect(toComputerStatus("bot-1", computer).takeoverRequested).toBe(true);
    expect(toComputerStatus("bot-1", { ...computer, controlRunId: null }).takeoverRequested).toBe(
      false,
    );
  });
});
