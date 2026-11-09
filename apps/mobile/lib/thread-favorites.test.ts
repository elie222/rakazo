// @vitest-environment jsdom

import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  stored: null as string | null,
  getItemAsync: vi.fn(async () => store.stored),
  setItemAsync: vi.fn(async (_key: string, value: string) => {
    store.stored = value;
  }),
}));

vi.mock("expo-secure-store", () => ({
  getItemAsync: store.getItemAsync,
  setItemAsync: store.setItemAsync,
}));

async function waitFor(condition: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    if (condition()) return;
  }
  throw new Error("timed out waiting for the store to settle");
}

describe("thread favorites", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    store.stored = null;
    store.getItemAsync.mockClear();
    store.setItemAsync.mockClear();
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container?.remove();
    root = undefined;
    container = undefined;
    vi.unstubAllGlobals();
  });

  async function mountFavoritesProbe(threadKey: string) {
    const mod = await import("./thread-favorites");
    let seen = mod.threadFavoritesFor(threadKey);
    function Probe() {
      seen = mod.useThreadFavorites(threadKey);
      return null;
    }
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root?.render(createElement(Probe));
    });
    return { mod, seen: () => seen };
  }

  it("truncates the snippet to 64 characters and collapses whitespace", async () => {
    const { favoriteSnippet } = await import("./thread-favorites");
    expect(favoriteSnippet("  hello\n\n world  ")).toBe("hello world");
    expect(favoriteSnippet("x".repeat(70))).toBe(`${"x".repeat(64)}…`);
    expect(favoriteSnippet("short")).toBe("short");
  });

  it("toggles a favorite on and off, newest first", async () => {
    const { isThreadFavorite, threadFavoritesFor, toggleThreadFavorite } =
      await import("./thread-favorites");
    const first = { messageId: "m1", snippet: "first", createdAt: 1 };
    const second = { messageId: "m2", snippet: "second", createdAt: 2 };
    expect(toggleThreadFavorite("bot-1", first)).toBe(true);
    expect(toggleThreadFavorite("bot-1", second)).toBe(true);
    expect(threadFavoritesFor("bot-1").map((item) => item.messageId)).toEqual(["m2", "m1"]);
    expect(isThreadFavorite("bot-1", "m1")).toBe(true);
    expect(toggleThreadFavorite("bot-1", first)).toBe(false);
    expect(threadFavoritesFor("bot-1").map((item) => item.messageId)).toEqual(["m2"]);
    expect(isThreadFavorite("bot-1", "m1")).toBe(false);
  });

  it("keeps favorites separate per thread", async () => {
    const { threadFavoritesFor, toggleThreadFavorite } = await import("./thread-favorites");
    toggleThreadFavorite("bot-1", { messageId: "m1", snippet: "one", createdAt: 1 });
    toggleThreadFavorite("group-1", { messageId: "m1", snippet: "one", createdAt: 1 });
    expect(threadFavoritesFor("bot-1")).toHaveLength(1);
    expect(threadFavoritesFor("group-1")).toHaveLength(1);
    expect(threadFavoritesFor("bot-2")).toEqual([]);
    expect(threadFavoritesFor(undefined)).toEqual([]);
  });

  it("persists toggles to storage", async () => {
    const { toggleThreadFavorite } = await import("./thread-favorites");
    toggleThreadFavorite("bot-1", { messageId: "m1", snippet: "one", createdAt: 1 });
    await waitFor(() => store.setItemAsync.mock.calls.length > 0);
    expect(store.setItemAsync).toHaveBeenCalledWith(
      "rakazo.thread-favorites",
      expect.stringContaining("m1"),
    );
  });

  it("loads stored favorites and drops a cleared conversation's", async () => {
    store.stored = JSON.stringify({
      "bot-1": [{ messageId: "m1", snippet: "one", createdAt: 1 }],
      "bot-2": [{ messageId: "m2", snippet: "two", createdAt: 2 }],
    });
    const { seen } = await mountFavoritesProbe("bot-1");
    await waitFor(() => seen().length > 0);
    expect(seen().map((item) => item.messageId)).toEqual(["m1"]);
    const { notifyConversationCleared } = await import("./conversation-cleared");
    const callsBefore = store.setItemAsync.mock.calls.length;
    act(() => {
      notifyConversationCleared("bot-1");
    });
    expect(seen()).toEqual([]);
    await waitFor(() => store.setItemAsync.mock.calls.length > callsBefore);
    expect(store.setItemAsync).toHaveBeenCalledWith(
      "rakazo.thread-favorites",
      expect.not.stringContaining("m1"),
    );
  });
});
