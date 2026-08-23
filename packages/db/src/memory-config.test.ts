import { describe, expect, it } from "vitest";
import {
  effectiveMemoryScope,
  supermemoryContainerTagFor,
  supermemoryContainerTagsFor,
  supermemoryHistoryContainerTagFor,
  supermemoryHistoryContainerTagsForClear,
  supermemoryRecallContainerTagsFor,
} from "./memory-config.js";

describe("effectiveMemoryScope", () => {
  it("uses the bot's own scope when set", () => {
    expect(effectiveMemoryScope("shared", "isolated")).toBe("shared");
  });

  it("falls back to the workspace default when the bot has none", () => {
    expect(effectiveMemoryScope(null, "shared")).toBe("shared");
  });
});

describe("supermemoryContainerTagFor", () => {
  it("scopes isolated memory to the bot", () => {
    expect(supermemoryContainerTagFor("isolated", "bot-123", "ws-1")).toBe("rakazo:bot-123");
  });

  it("scopes shared memory to the workspace", () => {
    expect(supermemoryContainerTagFor("shared", "bot-123", "ws-1")).toBe("rakazo:workspace:ws-1");
  });

  it("mirrors shared memory into the bot container so scope changes retain bot memories", () => {
    expect(supermemoryContainerTagsFor("shared", "bot-123", "ws-1")).toEqual([
      "rakazo:workspace:ws-1",
      "rakazo:bot-123",
    ]);
  });
});

describe("Supermemory history containers", () => {
  it("keeps every compaction generation separate from durable bot memory", () => {
    expect(supermemoryHistoryContainerTagFor("bot-123", 0)).toBe("rakazo:bot-123:history:0");
    expect(supermemoryHistoryContainerTagFor("bot-123", 2)).toBe("rakazo:bot-123:history:2");
  });

  it("recalls durable shared memory, its private mirror, and current conversation history", () => {
    expect(supermemoryRecallContainerTagsFor("shared", "bot-123", "ws-1", 2)).toEqual([
      "rakazo:workspace:ws-1",
      "rakazo:bot-123",
      "rakazo:bot-123:history:2",
    ]);
  });

  it("purges adjacent history generations without selecting the durable bot container", () => {
    expect(supermemoryHistoryContainerTagsForClear("bot-123", 1)).toEqual([
      "rakazo:bot-123:history:0",
      "rakazo:bot-123:history:1",
    ]);
    expect(supermemoryHistoryContainerTagsForClear("bot-123", 3)).toEqual([
      "rakazo:bot-123:history:2",
      "rakazo:bot-123:history:3",
    ]);
  });
});
