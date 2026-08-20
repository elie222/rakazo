import { describe, expect, it } from "vitest";
import { effectiveMemoryScope, supermemoryContainerTagFor } from "./memory-config.js";

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
});
