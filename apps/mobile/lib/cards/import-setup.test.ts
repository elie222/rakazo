import { importSetupStateInput, isImportSetupComplete, isImportSetupDone } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import type { ImportSetupBlock } from "./import-setup";
import { importSetupDetail } from "./import-setup";

const block: ImportSetupBlock = {
  kind: "import_setup",
  items: [
    { kind: "routine", routineId: "routine-1", name: "Morning briefing" },
    { kind: "model", title: "Model", provider: "acme", providerName: "Acme" },
    { kind: "mcp", serverId: "server-1", name: "Files", needs: [{ kind: "local_paths" }] },
  ],
};

const empty = { providers: {}, serverIds: {}, routineIds: {} };

describe("import setup checklist", () => {
  it("asks about each checkable item by kind", () => {
    expect(importSetupStateInput("bot-1", block)).toEqual({
      botId: "bot-1",
      providers: ["acme"],
      serverIds: ["server-1"],
      routineIds: ["routine-1"],
    });
  });

  it("marks a routine done once it is on, and never a server it cannot check", () => {
    const state = { ...empty, routineIds: { "routine-1": true }, serverIds: { "server-1": true } };
    expect(isImportSetupDone(block.items[0]!, null)).toBeNull();
    expect(isImportSetupDone(block.items[0]!, empty)).toBe(false);
    expect(isImportSetupDone(block.items[0]!, state)).toBe(true);
    expect(isImportSetupDone(block.items[2]!, state)).toBeNull();
  });

  it("is complete only when every row is checked done", () => {
    const routineOnly: ImportSetupBlock = { kind: "import_setup", items: [block.items[0]!] };
    expect(isImportSetupComplete(routineOnly, null)).toBe(false);
    expect(isImportSetupComplete(routineOnly, empty)).toBe(false);
    expect(
      isImportSetupComplete(routineOnly, { ...empty, routineIds: { "routine-1": true } }),
    ).toBe(true);
    expect(
      isImportSetupComplete(block, {
        providers: { acme: true },
        serverIds: { "server-1": true },
        routineIds: { "routine-1": true },
      }),
    ).toBe(false);
  });

  it("says what each row still needs", () => {
    expect(block.items.map(importSetupDetail)).toEqual([
      "Paused",
      "API key for Acme",
      "Uses paths on your computer",
    ]);
  });
});
