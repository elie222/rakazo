import { describe, expect, it } from "vitest";
import { BOT_COMPUTER_MODES, BOT_SETTINGS_ADVANCED_ORDER } from "./bot-settings-layout.js";
import type { ComputerMode } from "./domain.js";

describe("bot settings layout", () => {
  it("offers Team before Private using valid computer modes", () => {
    const modes: readonly ComputerMode[] = BOT_COMPUTER_MODES;
    expect(modes).toEqual(["team", "dedicated"]);
  });
  it("keeps voice with read aloud and bot management in Advanced", () => {
    expect(BOT_SETTINGS_ADVANCED_ORDER).toEqual([
      "instructions",
      "computer",
      "model",
      "thinking",
      "memoryScope",
      "readAloud",
      "voice",
      "fleetManagement",
      "scratchpad",
      "knowledge",
      "disabledTools",
      "credentials",
    ]);
    expect(new Set(BOT_SETTINGS_ADVANCED_ORDER).size).toBe(BOT_SETTINGS_ADVANCED_ORDER.length);
  });
});
