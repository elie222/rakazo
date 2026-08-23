import { describe, expect, it } from "vitest";
import {
  effectiveMemoryScope,
  supermemoryContainerTagFor,
  supermemoryContainerTagsFor,
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
    expect(supermemoryContainerTagFor("isolated", "bot-123", "ws-1", 2)).toBe(
      "rakazo:bot-123:history:2",
    );
  });

  it("scopes shared memory to the workspace", () => {
    expect(supermemoryContainerTagFor("shared", "bot-123", "ws-1")).toBe("rakazo:workspace:ws-1");
  });

  it("mirrors shared memory into the bot container so scope changes retain bot memories", () => {
    expect(supermemoryContainerTagsFor("shared", "bot-123", "ws-1", 2)).toEqual([
      "rakazo:workspace:ws-1",
      "rakazo:bot-123:history:2",
    ]);
  });
});
