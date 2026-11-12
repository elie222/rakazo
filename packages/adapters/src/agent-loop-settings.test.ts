import { describe, expect, it } from "vitest";
import {
  agentLoopSettingsFromEnv,
  DEFAULT_AGENT_LOOP_SETTINGS,
  silentToolContinuationPrompt,
} from "./agent-loop-settings.js";

describe("agentLoopSettingsFromEnv", () => {
  it("defaults to upstream behavior when unset", () => {
    expect(agentLoopSettingsFromEnv({})).toEqual(DEFAULT_AGENT_LOOP_SETTINGS);
  });

  it("enables flags from env", () => {
    expect(
      agentLoopSettingsFromEnv({
        RAKAZO_OPEN_WORK_LOOP_ENABLED: "true",
        RAKAZO_NON_BLOCKING_ASKS_ENABLED: "true",
        RAKAZO_SILENT_TOOL_CONTINUATIONS_MAX: "8",
        RAKAZO_SILENT_TOOL_CONTINUATION_MODE: "keep_going",
        RAKAZO_AGENT_CONTEXT_STRATEGY: "current",
        RAKAZO_AGENT_CONTEXT_COMPACTION_PIN_OPEN_WORK: "true",
      }),
    ).toMatchObject({
      openWorkLoop: { enabled: true, maxRewakes: 12 },
      nonBlockingAsks: true,
      silentToolContinuations: { max: 8, mode: "keep_going" },
      contextStrategy: "current",
      contextCompactionPinOpenWork: true,
    });
  });
});

describe("silentToolContinuationPrompt", () => {
  it("changes wording for keep_going mode", () => {
    const ask = silentToolContinuationPrompt("ask", false);
    const keep = silentToolContinuationPrompt("keep_going", false);
    expect(keep).not.toEqual(ask);
    expect(keep).toContain("Try another approach");
  });
});
