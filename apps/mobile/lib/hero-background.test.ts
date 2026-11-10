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

describe("hero background", () => {
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
    const mod = await import("./hero-background");
    let seen = mod.heroBackgroundFor(threadKey);
    function Probe() {
      seen = mod.useHeroBackground(threadKey);
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

  // Opacity clamping, the slider mapping, and URL validation live in the
  // shared chat-background helpers and are covered by its tests; the hero
  // store reuses them, so only hero-specific behavior is tested here.

  it("sets, adjusts and restores the background", async () => {
    const { heroBackgroundFor, setHeroBackground, setHeroBackgroundOpacity } = await import(
      "./hero-background"
    );
    expect(heroBackgroundFor("bot-1")).toBeNull();
    setHeroBackground("bot-1", { kind: "url", uri: "https://example.test/bg.jpg", opacity: 40 });
    expect(heroBackgroundFor("bot-1")).toMatchObject({ kind: "url", opacity: 40 });
    setHeroBackgroundOpacity("bot-1", 200);
    expect(heroBackgroundFor("bot-1")?.opacity).toBe(100);
    setHeroBackgroundOpacity("bot-2", 50);
    expect(heroBackgroundFor("bot-2")).toBeNull();
    setHeroBackground("bot-1", null);
    expect(heroBackgroundFor("bot-1")).toBeNull();
    await waitForSaves(3);
  });

  it("loads a stored background and persists changes", async () => {
    store.stored = JSON.stringify({
      "bot-1": { kind: "image", uri: "file:///doc/hero-backgrounds/bot-1-image.jpg", opacity: 60 },
    });
    const { mod, seen } = await mountBackgroundProbe("bot-1");
    await waitFor(() => seen() !== null);
    expect(seen()).toMatchObject({ kind: "image", opacity: 60 });
    mod.setHeroBackgroundOpacity("bot-1", 80);
    await waitFor(() => store.setItemAsync.mock.calls.length > 0);
    expect(store.setItemAsync).toHaveBeenCalledWith(
      "rakazo.hero-backgrounds",
      expect.stringContaining("80"),
    );
  });

  it("copies a picked file into documents and replaces the previous one", async () => {
    const { saveHeroBackgroundFile } = await import("./hero-background");
    const first = await saveHeroBackgroundFile(
      "bot-1",
      "file:///tmp/pick.jpg",
      "Photo.JPG",
      "image",
    );
    expect(first.uri).toBe("file:///doc/hero-backgrounds/bot-1-image.jpg");
    expect(first.name).toBe("Photo.JPG");
    expect(fsMocks.files.has("file:///doc/hero-backgrounds/bot-1-image.jpg")).toBe(true);
    const { setHeroBackground } = await import("./hero-background");
    setHeroBackground("bot-1", { kind: "image", uri: first.uri, opacity: 40 });
    const second = await saveHeroBackgroundFile(
      "bot-1",
      "file:///tmp/other.png",
      "Other.png",
      "image",
    );
    expect(second.uri).toBe("file:///doc/hero-backgrounds/bot-1-image.png");
    expect(fsMocks.files.has("file:///doc/hero-backgrounds/bot-1-image.jpg")).toBe(false);
    await waitForSaves(1);
  });

  it("deletes only background files inside the backgrounds folder", async () => {
    const { deleteHeroBackgroundFile } = await import("./hero-background");
    fsMocks.files.set("file:///doc/hero-backgrounds/bot-1-image.jpg", "copied");
    fsMocks.files.set("file:///tmp/keep.jpg", "copied");
    await deleteHeroBackgroundFile("file:///doc/hero-backgrounds/bot-1-image.jpg");
    await deleteHeroBackgroundFile("file:///tmp/keep.jpg");
    expect(fsMocks.files.has("file:///doc/hero-backgrounds/bot-1-image.jpg")).toBe(false);
    expect(fsMocks.files.has("file:///tmp/keep.jpg")).toBe(true);
  });

  it("stays independent of the chat background", async () => {
    const hero = await import("./hero-background");
    const chat = await import("./chat-background");
    hero.setHeroBackground("bot-1", {
      kind: "url",
      uri: "https://example.test/hero.jpg",
      opacity: 70,
    });
    chat.setChatBackground("bot-1", {
      kind: "url",
      uri: "https://example.test/chat.jpg",
      opacity: 40,
    });
    expect(hero.heroBackgroundFor("bot-1")).toMatchObject({
      uri: "https://example.test/hero.jpg",
      opacity: 70,
    });
    expect(chat.chatBackgroundFor("bot-1")).toMatchObject({
      uri: "https://example.test/chat.jpg",
      opacity: 40,
    });
    hero.setHeroBackgroundOpacity("bot-1", 90);
    expect(hero.heroBackgroundFor("bot-1")?.opacity).toBe(90);
    expect(chat.chatBackgroundFor("bot-1")?.opacity).toBe(40);
    hero.setHeroBackground("bot-1", null);
    expect(hero.heroBackgroundFor("bot-1")).toBeNull();
    expect(chat.chatBackgroundFor("bot-1")).not.toBeNull();
    await waitForSaves(4);
  });
});
