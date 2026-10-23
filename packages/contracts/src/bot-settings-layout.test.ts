import { describe, expect, it } from "vitest";
import { BOT_COMPUTER_MODES, BOT_SETTINGS_SECTIONS } from "./bot-settings-layout.js";
import type { ComputerMode } from "./domain.js";

describe("bot settings layout", () => {
  it("offers Team before Private using valid computer modes", () => {
    const modes: readonly ComputerMode[] = BOT_COMPUTER_MODES;
    expect(modes).toEqual(["team", "dedicated"]);
  });
  it("keeps voice with read aloud and bot management in Advanced", () => {
    expect(Object.keys(BOT_SETTINGS_SECTIONS)).toEqual([
      "profile",
      "openWork",
      "memory",
      "advanced",
    ]);
    expect(BOT_SETTINGS_SECTIONS.profile).toEqual(["instructions"]);
    expect(BOT_SETTINGS_SECTIONS.advanced).toEqual([
      "model",
      "thinking",
      "computer",
      "memoryScope",
      "readAloud",
      "voice",
      "fleetManagement",
      "description",
      "disabledTools",
      "credentials",
      "skills",
      "export",
      "clear",
    ]);
    const controls = Object.values(BOT_SETTINGS_SECTIONS).flat();
    expect(new Set(controls).size).toBe(controls.length);
  });
});
