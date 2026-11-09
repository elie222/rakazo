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

const fsMocks = vi.hoisted(() => ({
  files: new Map<string, string>(),
  dirs: new Set<string>(),
}));

vi.mock("expo-file-system", () => {
  class Directory {
    uri: string;
    constructor(parent: string | Directory, name?: string) {
      const base = typeof parent === "string" ? parent : parent.uri;
      this.uri = name === undefined ? base : `${base}/${name}`;
    }
    get exists() {
      return fsMocks.dirs.has(this.uri);
    }
    create() {
      fsMocks.dirs.add(this.uri);
    }
  }
  class File {
    uri: string;
    constructor(first: string | Directory, second?: string) {
      const base = typeof first === "string" ? first : first.uri;
      this.uri = second === undefined ? base : `${base}/${second}`;
    }
    get name() {
      return this.uri.split("/").pop() ?? "";
    }
    get exists() {
      return fsMocks.files.has(this.uri);
    }
    async copy(destination: File) {
      fsMocks.files.set(destination.uri, "copied");
    }
    delete() {
      fsMocks.files.delete(this.uri);
    }
  }
  return {
    Directory,
    File,
    Paths: { document: "file:///doc", cache: "file:///cache" },
  };
});

async function waitFor(condition: () => boolean) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    if (condition()) return;
  }
  throw new Error("timed out waiting for the store to settle");
}

/**
 * The store persists fire-and-forget; a test that mutates it must drain its
 * saves before the next test, or a late save overwrites the next test's
 * stored snapshot.
 */
async function waitForSaves(count: number) {
  await waitFor(() => store.setItemAsync.mock.calls.length >= count);
}

describe("chat background", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    store.stored = null;
    store.getItemAsync.mockClear();
    store.setItemAsync.mockClear();
    fsMocks.files.clear();
    fsMocks.dirs.clear();
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

  async function mountBackgroundProbe(threadKey: string) {
    const mod = await import("./chat-background");
    let seen = mod.chatBackgroundFor(threadKey);
    function Probe() {
      seen = mod.useChatBackground(threadKey);
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

  it("clamps opacity to 5–100 and falls back to the default", async () => {
    const { CHAT_BACKGROUND_DEFAULT_OPACITY, clampChatBackgroundOpacity } =
      await import("./chat-background");
    expect(clampChatBackgroundOpacity(40)).toBe(40);
    expect(clampChatBackgroundOpacity(1)).toBe(5);
    expect(clampChatBackgroundOpacity(500)).toBe(100);
    expect(clampChatBackgroundOpacity(40.6)).toBe(41);
    expect(clampChatBackgroundOpacity(Number.NaN)).toBe(CHAT_BACKGROUND_DEFAULT_OPACITY);
  });

  it("maps a slider position to an opacity", async () => {
    const { chatBackgroundOpacityFromRatio } = await import("./chat-background");
    expect(chatBackgroundOpacityFromRatio(0)).toBe(5);
    expect(chatBackgroundOpacityFromRatio(1)).toBe(100);
    expect(chatBackgroundOpacityFromRatio(0.5)).toBe(53);
    expect(chatBackgroundOpacityFromRatio(-1)).toBe(5);
    expect(chatBackgroundOpacityFromRatio(2)).toBe(100);
  });

  it("accepts only http(s) URLs for subscription", async () => {
    const { isChatBackgroundUrl } = await import("./chat-background");
    expect(isChatBackgroundUrl("https://example.test/bg.jpg")).toBe(true);
    expect(isChatBackgroundUrl("http://example.test/bg.jpg")).toBe(true);
    expect(isChatBackgroundUrl("ftp://example.test/bg.jpg")).toBe(false);
    expect(isChatBackgroundUrl("file:///bg.jpg")).toBe(false);
    expect(isChatBackgroundUrl("not a url")).toBe(false);
  });

  it("sets, adjusts and restores the background", async () => {
    const { chatBackgroundFor, setChatBackground, setChatBackgroundOpacity } =
      await import("./chat-background");
    expect(chatBackgroundFor("bot-1")).toBeNull();
    setChatBackground("bot-1", { kind: "url", uri: "https://example.test/bg.jpg", opacity: 40 });
    expect(chatBackgroundFor("bot-1")).toMatchObject({ kind: "url", opacity: 40 });
    setChatBackgroundOpacity("bot-1", 200);
    expect(chatBackgroundFor("bot-1")?.opacity).toBe(100);
    setChatBackgroundOpacity("bot-2", 50);
    expect(chatBackgroundFor("bot-2")).toBeNull();
    setChatBackground("bot-1", null);
    expect(chatBackgroundFor("bot-1")).toBeNull();
    await waitForSaves(3);
  });

  it("loads a stored background and persists changes", async () => {
    store.stored = JSON.stringify({
      "bot-1": { kind: "image", uri: "file:///doc/chat-backgrounds/bot-1-image.jpg", opacity: 60 },
    });
    const { mod, seen } = await mountBackgroundProbe("bot-1");
    await waitFor(() => seen() !== null);
    expect(seen()).toMatchObject({ kind: "image", opacity: 60 });
    mod.setChatBackgroundOpacity("bot-1", 80);
    await waitFor(() => store.setItemAsync.mock.calls.length > 0);
    expect(store.setItemAsync).toHaveBeenCalledWith(
      "rakazo.chat-backgrounds",
      expect.stringContaining("80"),
    );
  });

  it("copies a picked file into documents and replaces the previous one", async () => {
    const { saveChatBackgroundFile } = await import("./chat-background");
    const first = await saveChatBackgroundFile("bot-1", "file:///tmp/pick.jpg", "Photo.JPG", "image");
    expect(first.uri).toBe("file:///doc/chat-backgrounds/bot-1-image.jpg");
    expect(first.name).toBe("Photo.JPG");
    expect(fsMocks.files.has("file:///doc/chat-backgrounds/bot-1-image.jpg")).toBe(true);
    const { setChatBackground } = await import("./chat-background");
    setChatBackground("bot-1", { kind: "image", uri: first.uri, opacity: 40 });
    const second = await saveChatBackgroundFile("bot-1", "file:///tmp/other.png", "Other.png", "image");
    expect(second.uri).toBe("file:///doc/chat-backgrounds/bot-1-image.png");
    expect(fsMocks.files.has("file:///doc/chat-backgrounds/bot-1-image.jpg")).toBe(false);
    await waitForSaves(1);
  });

  it("deletes only background files inside the backgrounds folder", async () => {
    const { deleteChatBackgroundFile } = await import("./chat-background");
    fsMocks.files.set("file:///doc/chat-backgrounds/bot-1-image.jpg", "copied");
    fsMocks.files.set("file:///tmp/keep.jpg", "copied");
    await deleteChatBackgroundFile("file:///doc/chat-backgrounds/bot-1-image.jpg");
    await deleteChatBackgroundFile("file:///tmp/keep.jpg");
    expect(fsMocks.files.has("file:///doc/chat-backgrounds/bot-1-image.jpg")).toBe(false);
    expect(fsMocks.files.has("file:///tmp/keep.jpg")).toBe(true);
  });
});
