import { describe, expect, it } from "vitest";
import {
  DEFAULT_VOICE_CHAT_SCENARIO_ID,
  VOICE_CHAT_SCENARIOS,
  voiceChatScenario,
} from "./voice-chat-scenarios";

describe("mobile voice chat scenarios", () => {
  it("lists unique scenarios with a title and description each", () => {
    const ids = VOICE_CHAT_SCENARIOS.map((scenario) => scenario.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const scenario of VOICE_CHAT_SCENARIOS) {
      expect(scenario.id).toBeTruthy();
      expect(scenario.titleKey).toBeTruthy();
      expect(scenario.descriptionKey).toBeTruthy();
    }
  });

  it("keeps the default in the list, and only the default attaches nothing", () => {
    const fallback = voiceChatScenario(DEFAULT_VOICE_CHAT_SCENARIO_ID);
    expect(fallback.id).toBe(DEFAULT_VOICE_CHAT_SCENARIO_ID);
    for (const scenario of VOICE_CHAT_SCENARIOS) {
      if (scenario.id === DEFAULT_VOICE_CHAT_SCENARIO_ID) {
        expect(scenario.instruction).toBeNull();
      } else {
        expect(scenario.instruction).toContain("【情景：");
      }
    }
  });

  it("falls back to the default for an unknown id", () => {
    expect(voiceChatScenario("nope").id).toBe(DEFAULT_VOICE_CHAT_SCENARIO_ID);
    expect(voiceChatScenario(undefined).id).toBe(DEFAULT_VOICE_CHAT_SCENARIO_ID);
  });
});
