import { describe, expect, it } from "vitest";
import type { ComputerStatus } from "./computer.js";
import { computerControlUser, computerFreeFor, takeoverHandsBackOnClose } from "./computer.js";

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

describe("computerControlUser", () => {
  it("says the viewer first, then another person, then a working bot", () => {
    expect(
      computerControlUser(
        running({ controlHolder: "user", controlBotId: "bot-1" }),
        "bot-1",
        "Ada",
      ),
    ).toEqual({ by: "you" });
    expect(
      computerControlUser(
        running({ controlHolder: "user", controlledByOther: true, controlledByName: "Grace" }),
        "bot-1",
        "Ada",
      ),
    ).toEqual({ by: "person", name: "Grace" });
    expect(computerControlUser(running({ controlledByOther: true }), "bot-1", null)).toEqual({
      by: "person",
      name: null,
    });
    expect(computerControlUser(running(), "bot-1", "Ada")).toEqual({ by: "bot", name: "Ada" });
    expect(computerControlUser(running({ otherBotName: "Basil" }), "bot-1", null)).toEqual({
      by: "bot",
      name: "Basil",
    });
    expect(computerControlUser(running(), "bot-1", null)).toBeNull();
  });

  it("says when the viewer already holds the computer through another bot", () => {
    expect(
      computerControlUser(
        running({ controlHolder: "user", controlBotId: "bot-2", otherBotName: "Basil" }),
        "bot-1",
        null,
      ),
    ).toEqual({ by: "youWithBot", name: "Basil" });
  });
});

describe("computerFreeFor", () => {
  it("is free only for this bot's running computer that no one is using", () => {
    expect(computerFreeFor(running(), "bot-1", null)).toBe(true);
    expect(computerFreeFor(running(), "bot-2", null)).toBe(false);
    expect(computerFreeFor(running({ state: "stopped" }), "bot-1", null)).toBe(false);
    expect(computerFreeFor(running({ kind: "desktop" }), "bot-1", null)).toBe(false);
    expect(computerFreeFor(running(), "bot-1", "Ada")).toBe(false);
    expect(computerFreeFor(running({ otherBotName: "Basil" }), "bot-1", null)).toBe(false);
  });
});

describe("takeoverHandsBackOnClose", () => {
  it("keeps control taken to answer a bot's request for help", () => {
    expect(takeoverHandsBackOnClose(running())).toBe(true);
    expect(takeoverHandsBackOnClose(running({ takeoverRequested: true }))).toBe(false);
  });
});
