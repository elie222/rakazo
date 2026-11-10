// @vitest-environment jsdom

import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  values: new Map<string, string>(),
  getItemAsync: vi.fn(async (key: string) => store.values.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    store.values.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    store.values.delete(key);
  }),
}));

vi.mock("expo-secure-store", () => ({
  getItemAsync: store.getItemAsync,
  setItemAsync: store.setItemAsync,
  deleteItemAsync: store.deleteItemAsync,
}));

const fsMocks = vi.hoisted(() => ({
  files: new Map<string, string>(),
  dirs: new Set<string>(),
  downloads: [] as string[],
  failDownloadUrls: new Set<string>(),
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
    static createDownloadTask(url: string, destination: File) {
      return {
        downloadAsync: async () => {
          if (fsMocks.failDownloadUrls.has(url)) throw new Error("download failed");
          fsMocks.downloads.push(url);
          fsMocks.files.set(destination.uri, "downloaded");
          return { uri: destination.uri };
        },
        release: () => {},
      };
    }
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

// The real module requires PNG assets at the top level; in vitest each
// require resolves to the asset's path, which the tests assert on.

const MANIFEST_URL = "https://cdn.example.test/pack.json";
const MANIFEST = {
  name: "Summer pack",
  faces: {
    thinking: "https://cdn.example.test/pack/thinking.png",
    searching: "https://cdn.example.test/pack/searching.png",
    working: "https://cdn.example.test/pack/working.png",
    waiting: "https://cdn.example.test/pack/waiting.png",
    done: "https://cdn.example.test/pack/done.png",
    error: "https://cdn.example.test/pack/error.png",
  },
};

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

describe("expression faces", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    store.values.clear();
    store.getItemAsync.mockClear();
    store.setItemAsync.mockClear();
    store.deleteItemAsync.mockClear();
    fsMocks.files.clear();
    fsMocks.dirs.clear();
    fsMocks.downloads.length = 0;
    fsMocks.failDownloadUrls.clear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => structuredClone(MANIFEST),
      })),
    );
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

  async function mountFacesProbe(userId: string, botId: string) {
    const mod = await import("./expression-avatar");
    let seen = mod.chiefExpressionGallery(userId, botId);
    function Probe() {
      seen = mod.useExpressionFaces(userId, botId);
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

  it("maps every activity to its face slot", async () => {
    const { expressionSlotForActivity } = await import("./expression-avatar");
    expect(expressionSlotForActivity("idle")).toBe("thinking");
    expect(expressionSlotForActivity("reading")).toBe("searching");
    expect(expressionSlotForActivity("writing")).toBe("working");
    expect(expressionSlotForActivity("computer")).toBe("working");
    expect(expressionSlotForActivity("working")).toBe("working");
    expect(expressionSlotForActivity("waiting")).toBe("waiting");
    expect(expressionSlotForActivity("error")).toBe("error");
    expect(expressionSlotForActivity("working", true)).toBe("done");
  });

  it("accepts only http(s) pack URLs", async () => {
    const { isExpressionPackUrl } = await import("./expression-avatar");
    expect(isExpressionPackUrl("https://example.test/pack.json")).toBe(true);
    expect(isExpressionPackUrl("http://example.test/pack.json")).toBe(true);
    expect(isExpressionPackUrl("ftp://example.test/pack.json")).toBe(false);
    expect(isExpressionPackUrl("file:///pack.json")).toBe(false);
    expect(isExpressionPackUrl("not a url")).toBe(false);
  });

  it("parses a valid pack manifest and rejects bad ones", async () => {
    const { parseExpressionPackManifest } = await import("./expression-avatar");
    expect(parseExpressionPackManifest(MANIFEST)).toEqual({
      name: "Summer pack",
      faces: MANIFEST.faces,
    });
    expect(parseExpressionPackManifest({ ...MANIFEST, name: undefined })?.name).toBeUndefined();
    expect(parseExpressionPackManifest(null)).toBeNull();
    expect(parseExpressionPackManifest({ faces: { thinking: "https://x.test/a.png" } })).toBeNull();
    expect(
      parseExpressionPackManifest({
        faces: { ...MANIFEST.faces, done: "ftp://cdn.example.test/done.png" },
      }),
    ).toBeNull();
    expect(parseExpressionPackManifest({ name: "No faces" })).toBeNull();
  });

  it("resolves the built-in face without an override", async () => {
    const mod = await import("./expression-avatar");
    expect(mod.expressionFaceImageFor("user-1", "bot-1", "thinking")).toContain("thinking.png");
    expect(mod.expressionImageFor("reading", false, "user-1", "bot-1")).toContain("searching.png");
    expect(mod.expressionImageFor("working", true, "user-1", "bot-1")).toContain("done.png");
    const gallery = mod.chiefExpressionGallery("user-1", "bot-1");
    expect(gallery.map((face) => face.id)).toEqual([
      "thinking",
      "searching",
      "working",
      "waiting",
      "done",
      "error",
    ]);
    expect(gallery.every((face) => face.customized === false)).toBe(true);
  });

  it("copies a picked file into the account folder and restores the built-in face", async () => {
    const mod = await import("./expression-avatar");
    const saved = await mod.saveExpressionFaceFile(
      "user-1",
      "bot-1",
      "thinking",
      "file:///tmp/pick.jpg",
      "Photo.JPG",
      "local",
    );
    expect(saved.uri).toBe("file:///doc/expression-faces/user-1/bot-1-thinking-local.jpg");
    expect(fsMocks.files.has(saved.uri)).toBe(true);
    mod.setExpressionFace("user-1", "bot-1", "thinking", {
      uri: saved.uri,
      source: "local",
      name: saved.name,
    });
    expect(mod.faceOverrideFor("user-1", "bot-1", "thinking")).toMatchObject({
      source: "local",
    });
    expect(mod.expressionFaceImageFor("user-1", "bot-1", "thinking")).toEqual({
      uri: saved.uri,
    });
    expect(mod.chiefExpressionGallery("user-1", "bot-1")[0]?.customized).toBe(true);
    await waitForSaves(1);
    mod.restoreExpressionFace("user-1", "bot-1", "thinking");
    expect(mod.faceOverrideFor("user-1", "bot-1", "thinking")).toBeNull();
    expect(mod.expressionFaceImageFor("user-1", "bot-1", "thinking")).toContain("thinking.png");
    // Restoring removes the custom file best-effort, after the override clears.
    await waitFor(() => !fsMocks.files.has(saved.uri));
  });

  it("loads stored faces and the subscription for the account", async () => {
    store.values.set(
      "rakazo.expression-faces.user-1",
      JSON.stringify({
        "bot-1:thinking": {
          uri: "file:///doc/expression-faces/user-1/bot-1-thinking-local.jpg",
          source: "local",
        },
      }),
    );
    store.values.set(
      "rakazo.expression-subscriptions.user-1",
      JSON.stringify({
        "bot-1": { url: MANIFEST_URL, name: "Summer pack", updatedAt: 1000 },
      }),
    );
    const { mod, seen } = await mountFacesProbe("user-1", "bot-1");
    await waitFor(() => seen()[0]?.customized === true);
    expect(seen()[0]?.image).toEqual({
      uri: "file:///doc/expression-faces/user-1/bot-1-thinking-local.jpg",
    });
    expect(mod.expressionSubscriptionFor("user-1", "bot-1")).toMatchObject({
      url: MANIFEST_URL,
      name: "Summer pack",
    });
    expect(mod.expressionSubscriptionFor("user-2", "bot-1")).toBeNull();
  });

  it("subscribes, downloads six faces, and keeps a local pick", async () => {
    const mod = await import("./expression-avatar");
    mod.setExpressionFace("user-1", "bot-1", "done", {
      uri: "file:///doc/expression-faces/user-1/bot-1-done-local.jpg",
      source: "local",
    });
    const result = await mod.subscribeExpressionPack("user-1", "bot-1", MANIFEST_URL);
    expect(result).toEqual({ status: "ok", name: "Summer pack" });
    expect(fetch).toHaveBeenCalledWith(MANIFEST_URL);
    // Five downloads: the local pick on done is never overwritten.
    expect(fsMocks.downloads).toHaveLength(5);
    expect(fsMocks.downloads).not.toContain(MANIFEST.faces.done);
    expect(mod.faceOverrideFor("user-1", "bot-1", "done")).toMatchObject({ source: "local" });
    expect(mod.faceOverrideFor("user-1", "bot-1", "thinking")).toMatchObject({
      source: "subscription",
      uri: "file:///doc/expression-faces/user-1/bot-1-thinking-subscription.png",
    });
    expect(mod.expressionSubscriptionFor("user-1", "bot-1")).toMatchObject({
      url: MANIFEST_URL,
      name: "Summer pack",
    });
    await waitForSaves(7);
  });

  it("subscribe fails without touching faces", async () => {
    const mod = await import("./expression-avatar");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })),
    );
    await expect(mod.subscribeExpressionPack("user-1", "bot-1", MANIFEST_URL)).resolves.toEqual({
      status: "error",
      reason: "unreachable",
    });
    expect(mod.faceOverrideFor("user-1", "bot-1", "thinking")).toBeNull();
    expect(mod.expressionSubscriptionFor("user-1", "bot-1")).toBeNull();
    expect(fsMocks.downloads).toHaveLength(0);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ faces: {} }) })),
    );
    await expect(mod.subscribeExpressionPack("user-1", "bot-1", MANIFEST_URL)).resolves.toEqual({
      status: "error",
      reason: "invalid",
    });
    expect(mod.expressionSubscriptionFor("user-1", "bot-1")).toBeNull();
  });

  it("refresh only re-downloads subscription faces", async () => {
    const mod = await import("./expression-avatar");
    await mod.subscribeExpressionPack("user-1", "bot-1", MANIFEST_URL);
    expect(fsMocks.downloads).toHaveLength(6);
    mod.restoreExpressionFace("user-1", "bot-1", "waiting");
    mod.setExpressionFace("user-1", "bot-1", "done", {
      uri: "file:///doc/expression-faces/user-1/bot-1-done-local.jpg",
      source: "local",
    });
    fsMocks.downloads.length = 0;
    const result = await mod.refreshExpressionSubscription("user-1", "bot-1");
    expect(result.status).toBe("ok");
    // Waiting was restored to built-in, done is a local pick: neither re-downloads.
    expect(fsMocks.downloads).toHaveLength(4);
    expect(fsMocks.downloads).not.toContain(MANIFEST.faces.waiting);
    expect(fsMocks.downloads).not.toContain(MANIFEST.faces.done);
    expect(mod.faceOverrideFor("user-1", "bot-1", "waiting")).toBeNull();
    expect(mod.faceOverrideFor("user-1", "bot-1", "done")).toMatchObject({ source: "local" });
  });

  it("unsubscribe removes subscribed faces but keeps local picks", async () => {
    const mod = await import("./expression-avatar");
    await mod.subscribeExpressionPack("user-1", "bot-1", MANIFEST_URL);
    mod.setExpressionFace("user-1", "bot-1", "done", {
      uri: "file:///doc/expression-faces/user-1/bot-1-done-local.jpg",
      source: "local",
    });
    const thinkingUri = mod.faceOverrideFor("user-1", "bot-1", "thinking")?.uri;
    expect(thinkingUri).toBeTruthy();
    mod.unsubscribeExpressionPack("user-1", "bot-1");
    expect(mod.expressionSubscriptionFor("user-1", "bot-1")).toBeNull();
    expect(mod.faceOverrideFor("user-1", "bot-1", "thinking")).toBeNull();
    await waitFor(() => !fsMocks.files.has(thinkingUri!));
    expect(mod.faceOverrideFor("user-1", "bot-1", "done")).toMatchObject({ source: "local" });
  });

  it("clears one account's faces and files on sign-out", async () => {
    const mod = await import("./expression-avatar");
    mod.setExpressionFace("user-1", "bot-1", "thinking", {
      uri: "file:///doc/expression-faces/user-1/bot-1-thinking-local.jpg",
      source: "local",
    });
    mod.setExpressionFace("user-2", "bot-1", "thinking", {
      uri: "file:///doc/expression-faces/user-2/bot-1-thinking-local.jpg",
      source: "local",
    });
    fsMocks.files.set("file:///doc/expression-faces/user-1/bot-1-thinking-local.jpg", "copied");
    fsMocks.files.set("file:///doc/expression-faces/user-2/bot-1-thinking-local.jpg", "copied");
    await waitForSaves(2);
    await mod.clearExpressionFacesForUser("user-1");
    expect(store.values.has("rakazo.expression-faces.user-1")).toBe(false);
    expect(store.values.has("rakazo.expression-subscriptions.user-1")).toBe(false);
    expect(mod.faceOverrideFor("user-1", "bot-1", "thinking")).toBeNull();
    expect(fsMocks.files.has("file:///doc/expression-faces/user-1/bot-1-thinking-local.jpg")).toBe(
      false,
    );
    expect(mod.faceOverrideFor("user-2", "bot-1", "thinking")).toMatchObject({
      source: "local",
    });
    expect(fsMocks.files.has("file:///doc/expression-faces/user-2/bot-1-thinking-local.jpg")).toBe(
      true,
    );
  });

  it("keeps two consumers with different keys on stable snapshots", async () => {
    const mod = await import("./expression-avatar");
    let seenLoaded = mod.chiefExpressionGallery("user-1", "bot-1");
    let seenBare = mod.chiefExpressionGallery(undefined, "bot-1");
    function Loaded() {
      seenLoaded = mod.useExpressionFaces("user-1", "bot-1");
      return null;
    }
    function Bare() {
      seenBare = mod.useExpressionFaces(undefined, "bot-1");
      return null;
    }
    const tree = () => createElement("div", null, createElement(Loaded), createElement(Bare));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    // The chat's avatar already has its account; /bot-settings mounts with
    // no account until `me` loads. A single-slot gallery cache tore the
    // store here: each getSnapshot evicted the other's, so React threw
    // "Maximum update depth exceeded" and the screen showed only Retry.
    act(() => {
      root?.render(tree());
    });
    expect(seenLoaded).toHaveLength(6);
    expect(seenBare).toHaveLength(6);
    // Let the loaded account's stored faces settle, so no notify is pending.
    await waitFor(() => store.getItemAsync.mock.calls.length >= 2);
    const loadedBefore = seenLoaded;
    const bareBefore = seenBare;
    act(() => {
      root?.render(tree());
    });
    expect(seenLoaded).toBe(loadedBefore);
    expect(seenBare).toBe(bareBefore);
    // A shared face change re-renders both in one commit; neither snapshot
    // may be rebuilt out from under the other.
    act(() => {
      mod.setExpressionFace("user-1", "bot-1", "thinking", {
        uri: "file:///doc/expression-faces/user-1/bot-1-thinking-local.jpg",
        source: "local",
      });
    });
    await waitForSaves(1);
    expect(seenLoaded).toHaveLength(6);
    expect(seenBare).toHaveLength(6);
    const loadedAfter = seenLoaded;
    const bareAfter = seenBare;
    act(() => {
      root?.render(tree());
    });
    expect(seenLoaded).toBe(loadedAfter);
    expect(seenBare).toBe(bareAfter);
  });
});
