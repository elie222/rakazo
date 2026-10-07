import { describe, expect, it } from "vitest";
import { findSwitchTarget } from "./bot-switch";

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
  ])("finds Max in %j", (text) => {
    expect(findSwitchTarget(text, bots)?.id).toBe("bot-2");
  });

  it("matches a full multi-word name and a unique first name", () => {
    expect(findSwitchTarget("switch to the travel bot", bots)?.id).toBe("bot-3");
    expect(findSwitchTarget("switch to Travel", bots)?.id).toBe("bot-3");
    expect(findSwitchTarget("switch to Sam Ortiz", bots)?.id).toBe("bot-5");
  });

  it("leaves an ambiguous first name, an unknown bot, or a normal message alone", () => {
    expect(findSwitchTarget("switch to Sam", bots)).toBeUndefined();
    expect(findSwitchTarget("switch to Zelda", bots)).toBeUndefined();
    expect(findSwitchTarget("tell Max I said hi", bots)).toBeUndefined();
    expect(findSwitchTarget("should we switch to Max's plan for the launch", bots)).toBeUndefined();
  });
});
