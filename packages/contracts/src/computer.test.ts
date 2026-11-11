import { describe, expect, it } from "vitest";
import type { ComputerStatus } from "./computer.js";
import { mayTakeComputerControl } from "./computer.js";

function running(overrides: Partial<ComputerStatus> = {}): ComputerStatus {
  return {
    botId: "bot-1",
    mode: "team",
    kind: "docker",
    state: "running",
    controlHolder: "none",
    controlBotId: null,
    takeoverRequested: false,
    screenAvailable: true,
    screenWidth: 1280,
    screenHeight: 800,
    homeRevision: null,
    busyBotName: null,
    canUpdate: false,
    terminalAvailable: false,
    ...overrides,
  };
}

describe("mayTakeComputerControl", () => {
  it("takes a free computer and answers this bot's own request", () => {
    expect(mayTakeComputerControl(running(), "bot-1", false)).toBe(true);
    expect(
      mayTakeComputerControl(
        running({ takeoverRequested: true, controlBotId: "bot-1" }),
        "bot-1",
        false,
      ),
    ).toBe(true);
  });

  it("never skips another bot's request for help on a shared computer", () => {
    for (const controlHolder of ["none", "user"] as const) {
      expect(
        mayTakeComputerControl(
          running({ takeoverRequested: true, controlHolder, controlBotId: "bot-2" }),
          "bot-1",
          false,
        ),
      ).toBe(false);
    }
  });

  it("leaves a computer another person, a working run or a bot waiting on someone else holds", () => {
    expect(
      mayTakeComputerControl(
        running({ controlHolder: "user", controlledByOther: true }),
        "bot-1",
        false,
      ),
    ).toBe(false);
    expect(
      mayTakeComputerControl(
        running({ takeoverRequested: true, controlBotId: "bot-1", controlledByOther: true }),
        "bot-1",
        false,
      ),
    ).toBe(false);
    expect(mayTakeComputerControl(running({ busyBotName: "Ada" }), "bot-1", true)).toBe(false);
  });

  it("does nothing for a computer it already holds or a desktop", () => {
    expect(
      mayTakeComputerControl(
        running({ controlHolder: "user", controlBotId: "bot-1" }),
        "bot-1",
        false,
      ),
    ).toBe(false);
    expect(mayTakeComputerControl(running({ kind: "desktop" }), "bot-1", false)).toBe(false);
  });
});
