import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeToolActivity, stepStatusOf } from "./pi-runtime-tools.js";
import type { RunContext } from "./run-context.js";
import { isOpeningAcknowledgement } from "./run-progress.js";
import {
  longWorkProgressGuidance,
  replyGuidanceForOfferedTools,
  runReplyGuidance,
} from "./run-replies.js";

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

    it("narrates live only where a person reads the run as it comes", () => {
      expect(runReplyGuidance("user")).toContain("live_status field");
      expect(runReplyGuidance("bot_message")).not.toContain("live_status field");
      expect(runReplyGuidance("bot_message")).toContain("never to announce that you are starting");
    });

    it("tells a group member a message named nobody not to open with a sentence", () => {
      expect(runReplyGuidance("user", "chat", { mayStaySilent: true })).not.toContain(
        "live_status field",
      );
    });

    it("keeps the live guidance for bots without message_user", () => {
      const guidance = replyGuidanceForOfferedTools(
        runReplyGuidance("user"),
        new Set(["message_user"]),
      );
      expect(guidance).toContain("live_status field");
      expect(guidance).not.toContain("message_user");
    });

    it("posts no opening when the attempt resumes earlier work", () => {
      const ctx = (resumesEarlierWork: boolean) =>
        ({
          replyMode: "chat",
          run: { trigger: "user" },
          groupReplyOptional: false,
          state: {
            reply: {
              midTurnProgressCount: 0,
              resumesEarlierWork,
              toolCalls: [{ executionId: "call-1" }],
            },
          },
        }) as unknown as RunContext;
      expect(isOpeningAcknowledgement(ctx(false), true, "I'll check that.")).toBe(true);
      expect(isOpeningAcknowledgement(ctx(true), true, "I'll check that.")).toBe(false);
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
