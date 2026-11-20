import { MEMORY_DREAM_TRIGGER } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { MEMORY_DREAM_TOOL_NAMES, selectBuiltinToolsForRun } from "./run-tool-selection.js";

/** Only the options the dream filter reads; the rest are irrelevant to it. */
function options(trigger: string) {
  return {
    trigger,
    graphicalToolsAllowed: true,
    groupId: null,
    semanticMemoryEnabled: true,
    ticketBoardEnabled: true,
    phoneCallsEnabled: true,
    historyRetrievalEnabled: true,
    meetingTranscriptsAvailable: true,
    disabled: new Set<string>(),
    hasTeammates: true,
    hasGroups: true,
    ownerStartedRun: true,
    fleetManagement: true,
  } as never;
}

describe("memory dream tool selection", () => {
  it("offers only the memory writes, so a dream cannot act elsewhere", () => {
    const names = new Set(
      selectBuiltinToolsForRun(options(MEMORY_DREAM_TRIGGER)).map((tool) => tool.name),
    );
    expect([...names].sort()).toEqual([...MEMORY_DREAM_TOOL_NAMES].sort());
    expect(names.has("remember")).toBe(true);
    expect(names.has("shell")).toBe(false);
    expect(names.has("run_subagent")).toBe(false);
  });

  it("still offers the other tools to a normal run", () => {
    const names = new Set(selectBuiltinToolsForRun(options("user")).map((tool) => tool.name));
    expect(names.has("shell")).toBe(true);
    expect(names.has("remember")).toBe(true);
  });
});
