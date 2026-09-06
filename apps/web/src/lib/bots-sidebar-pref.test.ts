import { describe, expect, it, vi } from "vitest";
import {
  botsSidebarCollapsedStorageKey,
  readBotsSidebarCollapsed,
  writeBotsSidebarCollapsed,
} from "./bots-sidebar-pref";

describe("bots sidebar collapse preference", () => {
  it("builds a per-user storage key", () => {
    expect(botsSidebarCollapsedStorageKey(null)).toBeNull();
    expect(botsSidebarCollapsedStorageKey("user-1")).toBe("rakazo:bots-sidebar-collapsed:user-1");
  });

  it("reads and writes collapsed state", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
          store.set(key, value);
        },
        removeItem: (key: string) => {
          store.delete(key);
        },
      },
    });
    expect(readBotsSidebarCollapsed("user-1")).toBe(false);
    writeBotsSidebarCollapsed("user-1", true);
    expect(readBotsSidebarCollapsed("user-1")).toBe(true);
    writeBotsSidebarCollapsed("user-1", false);
    expect(readBotsSidebarCollapsed("user-1")).toBe(false);
    vi.unstubAllGlobals();
  });
});
