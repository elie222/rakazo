import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeToolActivity, stepStatusOf } from "./pi-runtime-tools.js";
import { longWorkProgressGuidance } from "./run-replies.js";

describe("step status field", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("with RAKAZO_OPENING_ACKNOWLEDGEMENT=1", () => {
    beforeEach(() => {
      vi.stubEnv("RAKAZO_OPENING_ACKNOWLEDGEMENT", "1");
    });

    it("shows the model's status instead of the tool detail", () => {
      expect(
        describeToolActivity("shell", {
          command: "cd /workspace && python3 -c 'print(1)'",
          status: "  Reading the   ledger ",
        }),
      ).toBe("Reading the ledger");
    });

    it("reads the status given on a use_tool call", () => {
      expect(
        describeToolActivity("use_tool", {
          name: "create_space",
          arguments: { name: "Finance" },
          status: "Creating the space",
        }),
      ).toBe("Creating the space");
    });

    it("falls back to the tool detail without a usable status", () => {
      expect(describeToolActivity("shell", { command: "ls", status: "   " })).toBe("Running: ls");
      expect(stepStatusOf({ status: 42 })).toBeUndefined();
    });

    it("cuts a long status to one working line", () => {
      const status = stepStatusOf({ status: "word ".repeat(20) });
      expect(status?.endsWith("…")).toBe(true);
      expect(status!.length).toBeLessThanOrEqual(61);
    });

    it("asks for the status field in the guidance", () => {
      expect(longWorkProgressGuidance()).toContain("status field");
    });
  });

  it("ignores the field when live narration is off", () => {
    expect(describeToolActivity("shell", { command: "ls", status: "Listing" })).toBe("Running: ls");
    expect(longWorkProgressGuidance()).toContain("never to announce that you are starting");
  });
});
