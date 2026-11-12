import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeToolActivity, stepStatusOf } from "./pi-runtime-tools.js";
import { longWorkProgressGuidance } from "./run-replies.js";

/** Tools this runtime offered the `live_status` field to. */
const narrated = new Set(["shell", "use_tool", "create_space"]);

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
        describeToolActivity(
          "shell",
          {
            command: "cd /workspace && python3 -c 'print(1)'",
            live_status: "  Reading the   ledger ",
          },
          undefined,
          narrated,
        ),
      ).toBe("Reading the ledger");
    });

    it("reads the status given on a use_tool call, outside or inside its arguments", () => {
      const call = (args: Record<string, unknown>) =>
        describeToolActivity("use_tool", { name: "create_space", ...args }, undefined, narrated);
      expect(call({ arguments: { name: "Finance" }, live_status: "Creating the space" })).toBe(
        "Creating the space",
      );
      expect(call({ arguments: { name: "Finance", live_status: "Setting up Finance" } })).toBe(
        "Setting up Finance",
      );
    });

    it("leaves a tool's own status argument alone", () => {
      expect(stepStatusOf("ticket_update", { id: "t1", status: "done" }, narrated)).toBeUndefined();
      expect(
        stepStatusOf(
          "use_tool",
          { name: "ticket_update", arguments: { id: "t1", status: "done" } },
          narrated,
        ),
      ).toBeUndefined();
    });

    it("falls back to the tool detail without a usable status", () => {
      expect(
        describeToolActivity("shell", { command: "ls", live_status: "   " }, undefined, narrated),
      ).toBe("Running: ls");
      expect(stepStatusOf("shell", { live_status: 42 }, narrated)).toBeUndefined();
    });

    it("cuts a long status to one working line", () => {
      const status = stepStatusOf("shell", { live_status: "word ".repeat(20) }, narrated);
      expect(status?.endsWith("…")).toBe(true);
      expect(status!.length).toBeLessThanOrEqual(61);
    });

    it("asks for the status field in the guidance", () => {
      expect(longWorkProgressGuidance()).toContain("live_status field");
    });
  });

  it("ignores the field when no tool was offered it", () => {
    expect(describeToolActivity("shell", { command: "ls", live_status: "Listing" })).toBe(
      "Running: ls",
    );
    expect(longWorkProgressGuidance()).toContain("never to announce that you are starting");
  });
});
