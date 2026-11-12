import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  boundedInRunCheckpoint,
  compactedInRunContext,
  DEFAULT_IN_RUN_CHECKPOINT_CONTEXT_FRACTION,
  inRunCheckpointBudgets,
  inRunCheckpointContextFraction,
  shouldCreateInRunCheckpoint,
} from "./in-run-checkpoint.js";

const model = { contextWindow: 100_000 } as Model<Api>;
const decision = {
  strategy: "retrieval" as const,
  predictedCache: "unknown" as const,
  estimatedInputTokens: 60_000,
  droppedMessages: 10,
  truncatedToolResults: 4,
  observedReuse: null,
};

describe("in-run checkpoint pressure", () => {
  it("uses a bounded deployment override", () => {
    expect(inRunCheckpointContextFraction({} as NodeJS.ProcessEnv)).toBe(
      DEFAULT_IN_RUN_CHECKPOINT_CONTEXT_FRACTION,
    );
    expect(
      inRunCheckpointContextFraction({
        IN_RUN_CHECKPOINT_CONTEXT_FRACTION: "0.7",
      } as NodeJS.ProcessEnv),
    ).toBe(0.7);
    expect(
      inRunCheckpointContextFraction({
        IN_RUN_CHECKPOINT_CONTEXT_FRACTION: "0.2",
      } as NodeJS.ProcessEnv),
    ).toBe(DEFAULT_IN_RUN_CHECKPOINT_CONTEXT_FRACTION);
  });

  it("waits for both tool work and context pressure", () => {
    expect(shouldCreateInRunCheckpoint({ decision, model, toolCalls: 0, fraction: 0.6 })).toBe(
      false,
    );
    expect(shouldCreateInRunCheckpoint({ decision, model, toolCalls: 1, fraction: 0.6 })).toBe(
      true,
    );
    expect(
      shouldCreateInRunCheckpoint({
        decision: { ...decision, estimatedInputTokens: 59_999 },
        model,
        toolCalls: 1,
        fraction: 0.6,
      }),
    ).toBe(false);
    expect(
      shouldCreateInRunCheckpoint({
        decision,
        model,
        toolCalls: 1,
        fraction: 0.6,
        minimumInputTokens: 60_001,
      }),
    ).toBe(false);
    expect(
      shouldCreateInRunCheckpoint({
        decision,
        model,
        toolCalls: 100,
        operationKind: "compaction",
        fraction: 0.6,
      }),
    ).toBe(false);
  });

  it("replaces tool history while retaining canonical system and user context", () => {
    const compacted = compactedInRunContext({
      source: {
        systemPrompt: "Keep the bot's durable instructions.",
        tools: [],
        messages: [
          { role: "system", content: "Keep approval boundaries.", timestamp: 1 },
          { role: "user", content: "Find inexpensive parts.", timestamp: 2 },
          {
            role: "assistant",
            content: [{ type: "text", text: "Working" }],
            api: "openai-completions",
            provider: "fixture",
            model: "fixture",
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: 3,
          },
          {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "computer_act",
            content: [{ type: "text", text: "large raw browser result" }],
            isError: false,
            timestamp: 4,
          },
        ],
      },
      tools: [],
      summary: "Checked page one. Next: inspect page two.",
    });

    expect(compacted.messages.map((message) => message.role)).toEqual(["system", "user", "user"]);
    expect(JSON.stringify(compacted.messages)).not.toContain("large raw browser result");
    expect(JSON.stringify(compacted.messages)).toContain("Checked page one");
    expect(compacted.systemPrompt).toBe("Keep the bot's durable instructions.");
  });

  it("keeps recent user images and bounds user text to the active model window", () => {
    const compacted = compactedInRunContext({
      source: {
        tools: [],
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: `begin ${"detail ".repeat(2_000)} end` },
              ...Array.from({ length: 6 }, (_, index) => ({
                type: "image" as const,
                data: `fixture-image-${index}`,
                mimeType: "image/png",
              })),
            ],
            timestamp: 1,
          },
        ],
      },
      tools: [],
      summary: "Continue from the screenshot.",
      contextWindow: 5_000,
      maxImages: 2,
    });

    const wire = JSON.stringify(compacted.messages);
    expect(wire).toContain("fixture-image-0");
    expect(wire).toContain("fixture-image-1");
    expect(wire).not.toContain("fixture-image-2");
    expect(wire).toContain("older user text clipped");
    expect(wire).toContain("Continue from the screenshot");
    expect(wire.length).toBeLessThan(10_000);
  });

  it("shares a small-window budget and rejects an oversized checkpoint", () => {
    const budgets = inRunCheckpointBudgets(2_048);
    expect(budgets.checkpointChars + budgets.userChars).toBeLessThanOrEqual(3_277);
    expect(budgets.checkpointChars).toBeGreaterThan(0);
    expect(budgets.userChars).toBeGreaterThan(0);
    expect(
      boundedInRunCheckpoint("x".repeat(budgets.checkpointChars + 1), budgets.checkpointChars),
    ).toBe("");
    expect(() =>
      compactedInRunContext({
        source: {
          tools: [],
          messages: [{ role: "user", content: "Keep this goal.", timestamp: 1 }],
        },
        tools: [],
        summary: "x".repeat(budgets.checkpointChars + 1),
        contextWindow: 2_048,
      }),
    ).toThrow("without a summary");
  });
});
