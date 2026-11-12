import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  compactedInRunContext,
  DEFAULT_IN_RUN_CHECKPOINT_CONTEXT_FRACTION,
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
        toolCalls: 100,
        operationKind: "compaction",
        fraction: 0.6,
      }),
    ).toBe(false);
  });

  it("replaces tool history while retaining canonical system and user context", () => {
    const compacted = compactedInRunContext({
      source: {
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
  });
});
