import { describe, expect, it } from "vitest";
import { findSwitchTarget, ringOnArrival, takeRingOnArrival } from "./bot-switch";

const bots = [
  { id: "bot-1", name: "Ada" },
  { id: "bot-2", name: "Max" },
  { id: "bot-3", name: "Travel Bot" },
  { id: "bot-4", name: "Sam Lee" },
  { id: "bot-5", name: "Sam Ortiz" },
];

describe("findSwitchTarget", () => {
  it.each([
    "switch to Max",
    "Please switch to Max.",
    "please switch to max please",
    "Can you put me through to Max?",
    "OK, switch me over to Max!",
    "connect me with Max",
    "swap to Max",
    "transfer to Max",
    "take me to Max",
  ])("finds Max in %j", (text) => {
    expect(findSwitchTarget(text, bots)?.id).toBe("bot-2");
  });

  it.each(["go with Max", "go to Max", "change to Max"])("leaves %j as a message", (text) => {
    expect(findSwitchTarget(text, bots)).toBeUndefined();
  });

  it("matches a full multi-word name and a unique first name", () => {
    expect(findSwitchTarget("switch to the travel bot", bots)?.id).toBe("bot-3");
    expect(findSwitchTarget("switch to Travel", bots)?.id).toBe("bot-3");
    expect(findSwitchTarget("switch to Sam Ortiz", bots)?.id).toBe("bot-5");
  });

  it("matches a full name that starts with 'the' before reading 'the' as an article", () => {
    const named = [
      { id: "bot-a", name: "The Planner" },
      { id: "bot-b", name: "Planner" },
    ];
    expect(findSwitchTarget("switch to The Planner", named)?.id).toBe("bot-a");
    expect(findSwitchTarget("switch to Planner", named)?.id).toBe("bot-b");
  });

  it("leaves an ambiguous first name, an unknown bot, or a normal message alone", () => {
    expect(findSwitchTarget("switch to Sam", bots)).toBeUndefined();
    expect(findSwitchTarget("switch to Zelda", bots)).toBeUndefined();
    expect(findSwitchTarget("tell Max I said hi", bots)).toBeUndefined();
    expect(findSwitchTarget("should we switch to Max's plan for the launch", bots)).toBeUndefined();
  });

  it("matches the complete name before removing a polite suffix", () => {
    const named = [
      { id: "travel-please", name: "Travel Please" },
      { id: "travel", name: "Travel" },
    ];
    expect(findSwitchTarget("switch to Travel Please", named)?.id).toBe("travel-please");
    expect(findSwitchTarget("switch to Travel Please, please!", named)?.id).toBe("travel-please");
    expect(findSwitchTarget("switch to Travel please", [named[1]!])?.id).toBe("travel");
    expect(findSwitchTarget("switch to Travel please", bots)?.id).toBe("bot-3");
  });
});

describe("ringOnArrival", () => {
  it("rings only the requested bot, once, and only soon after the hand-over", () => {
    ringOnArrival("max", 1_000);
    expect(takeRingOnArrival("max", 2_000)).toBe(true);
    expect(takeRingOnArrival("max", 2_000)).toBe(false);

    ringOnArrival("max", 1_000);
    expect(takeRingOnArrival("riley", 2_000)).toBe(false);
    expect(takeRingOnArrival("max", 2_000)).toBe(false);

    ringOnArrival("max", 1_000);
    expect(takeRingOnArrival("max", 12_000)).toBe(false);
  });

  it("does not ring without a hand-over", () => {
    expect(takeRingOnArrival("max")).toBe(false);
  });
});
