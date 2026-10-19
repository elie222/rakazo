import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async (key: string) => store.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    store.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    store.delete(key);
  }),
}));

describe("mobile avatar style cache", () => {
  beforeEach(() => {
    store.clear();
    vi.resetModules();
  });

  it("falls back to the default style when clearing cannot delete the stored one", async () => {
    const SecureStore = await import("expo-secure-store");
    const { AVATAR_STYLE_KEY, clearAvatarStyle, loadAvatarStyle, saveAvatarStyle } = await import(
      "./avatar-style"
    );
    await saveAvatarStyle("organic");
    vi.mocked(SecureStore.deleteItemAsync).mockRejectedValueOnce(new Error("locked"));

    await clearAvatarStyle();

    expect(store.get(AVATAR_STYLE_KEY)).toBe("robot");
    await expect(loadAvatarStyle()).resolves.toBe("robot");
  });

  it("defaults to robot and ignores an unknown stored value", async () => {
    const { AVATAR_STYLE_KEY, getCachedAvatarStyle, loadAvatarStyle } = await import(
      "./avatar-style"
    );
    expect(getCachedAvatarStyle()).toBe("robot");
    store.set(AVATAR_STYLE_KEY, "pixel");
    await expect(loadAvatarStyle()).resolves.toBe("robot");
  });

  it("starts from the last confirmed style on the next launch", async () => {
    const first = await import("./avatar-style");
    await first.saveAvatarStyle("organic");
    expect(store.get(first.AVATAR_STYLE_KEY)).toBe("organic");

    vi.resetModules();
    const next = await import("./avatar-style");
    expect(next.getCachedAvatarStyle()).toBe("robot");
    await expect(next.loadAvatarStyle()).resolves.toBe("organic");
    expect(next.getCachedAvatarStyle()).toBe("organic");
  });

  it("keeps the default when SecureStore cannot be read", async () => {
    const SecureStore = await import("expo-secure-store");
    const { loadAvatarStyle } = await import("./avatar-style");
    vi.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(new Error("device locked"));
    await expect(loadAvatarStyle()).resolves.toBe("robot");
  });

  it("retries a style whose save failed", async () => {
    const SecureStore = await import("expo-secure-store");
    const { AVATAR_STYLE_KEY, getCachedAvatarStyle, saveAvatarStyle } = await import(
      "./avatar-style"
    );
    vi.mocked(SecureStore.setItemAsync).mockRejectedValueOnce(new Error("device locked"));
    await saveAvatarStyle("organic");
    expect(store.has(AVATAR_STYLE_KEY)).toBe(false);
    expect(getCachedAvatarStyle()).toBe("organic");

    await saveAvatarStyle("organic");
    expect(store.get(AVATAR_STYLE_KEY)).toBe("organic");
  });

  it("clears the cached style", async () => {
    const { AVATAR_STYLE_KEY, clearAvatarStyle, getCachedAvatarStyle, saveAvatarStyle } =
      await import("./avatar-style");
    await saveAvatarStyle("organic");
    await clearAvatarStyle();
    expect(store.has(AVATAR_STYLE_KEY)).toBe(false);
    expect(getCachedAvatarStyle()).toBe("robot");
  });

  it("discards a late save that finishes after clear", async () => {
    const SecureStore = await import("expo-secure-store");
    const { AVATAR_STYLE_KEY, clearAvatarStyle, getCachedAvatarStyle, saveAvatarStyle } =
      await import("./avatar-style");

    let finishSave!: () => void;
    const gate = new Promise<void>((resolve) => {
      finishSave = resolve;
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementationOnce(async (key, value) => {
      await gate;
      store.set(key, value);
    });

    const save = saveAvatarStyle("organic");
    await Promise.resolve();
    const clearing = clearAvatarStyle();
    finishSave();
    await Promise.all([save, clearing]);

    expect(store.has(AVATAR_STYLE_KEY)).toBe(false);
    expect(getCachedAvatarStyle()).toBe("robot");
  });

  it("keeps the newer style when an older save finishes last", async () => {
    const SecureStore = await import("expo-secure-store");
    const { AVATAR_STYLE_KEY, getCachedAvatarStyle, saveAvatarStyle } = await import(
      "./avatar-style"
    );
    let releaseFirst: () => void = () => undefined;
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let writes = 0;
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key: string, value: string) => {
      writes += 1;
      if (writes === 1) await firstWrite;
      store.set(key, value);
    });

    try {
      const first = saveAvatarStyle("organic");
      await Promise.resolve();
      const second = saveAvatarStyle("robot");
      releaseFirst();
      await Promise.all([first, second]);

      expect(getCachedAvatarStyle()).toBe("robot");
      expect(store.get(AVATAR_STYLE_KEY)).toBe("robot");
    } finally {
      releaseFirst();
      vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key: string, value: string) => {
        store.set(key, value);
      });
    }
  });

  it("reports failure when the previous style stays on disk", async () => {
    const SecureStore = await import("expo-secure-store");
    const { AVATAR_STYLE_KEY, clearAvatarStyle, getCachedAvatarStyle, saveAvatarStyle } =
      await import("./avatar-style");
    await saveAvatarStyle("organic");
    vi.mocked(SecureStore.deleteItemAsync).mockRejectedValue(new Error("device locked"));
    vi.mocked(SecureStore.setItemAsync).mockRejectedValue(new Error("device locked"));

    try {
      await expect(clearAvatarStyle()).resolves.toBe(false);
      expect(store.get(AVATAR_STYLE_KEY)).toBe("organic");
      expect(getCachedAvatarStyle()).toBe("organic");
    } finally {
      vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key: string) => {
        store.delete(key);
      });
      vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key: string, value: string) => {
        store.set(key, value);
      });
    }
  });
});

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function afterMicrotasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("avatar style refresh and update", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("does not let a foreground read replace a newer in-flight update", async () => {
    const { createAvatarStyleClient } = await import("./avatar-style");
    const read = deferred<"robot" | "organic">();
    const write = deferred<"robot" | "organic">();
    const published: string[] = [];
    const generation = 1;
    const client = createAvatarStyleClient({
      read: () => read.promise,
      write: () => write.promise,
      publish: (style) => published.push(style),
      generation: () => generation,
      save: async () => true,
    });

    client.refresh();
    const update = client.update("organic");
    client.refresh();
    read.resolve("robot");
    await afterMicrotasks();
    expect(published).toEqual([]);

    write.resolve("organic");
    await update;
    await afterMicrotasks();
    // The refresh queued during the update runs afterward with the shared read.
    expect(published).toEqual(["organic", "robot"]);
  });

  it("applies a refresh that starts after the update has finished", async () => {
    const { createAvatarStyleClient } = await import("./avatar-style");
    const write = deferred<"robot" | "organic">();
    const read = deferred<"robot" | "organic">();
    const published: string[] = [];
    const client = createAvatarStyleClient({
      read: () => read.promise,
      write: () => write.promise,
      publish: (style) => published.push(style),
      generation: () => 1,
      save: async () => true,
    });

    const update = client.update("organic");
    write.resolve("organic");
    await update;
    client.refresh();
    read.resolve("robot");
    await afterMicrotasks();

    expect(published).toEqual(["organic", "robot"]);
  });

  it("drops a style response after the session generation changes", async () => {
    const { createAvatarStyleClient } = await import("./avatar-style");
    const read = deferred<"robot" | "organic">();
    const published: string[] = [];
    const saved: string[] = [];
    let generation = 1;
    const client = createAvatarStyleClient({
      read: () => read.promise,
      write: async () => "organic",
      publish: (style) => published.push(style),
      generation: () => generation,
      save: async (seen, style) => {
        if (seen !== generation) return false;
        saved.push(style);
        return true;
      },
    });

    client.refresh();
    generation = 2;
    read.resolve("organic");
    await afterMicrotasks();

    expect(saved).toEqual([]);
    expect(published).toEqual([]);
  });

  it("runs a deferred refresh after an in-flight update finishes", async () => {
    const { createAvatarStyleClient } = await import("./avatar-style");
    const write = deferred<"robot" | "organic">();
    const read = deferred<"robot" | "organic">();
    const published: string[] = [];
    let reads = 0;
    const client = createAvatarStyleClient({
      read: () => {
        reads += 1;
        return read.promise;
      },
      write: () => write.promise,
      publish: (style) => published.push(style),
      generation: () => 1,
      save: async () => true,
    });

    const update = client.update("organic");
    client.refresh();
    expect(reads).toBe(0);

    write.resolve("organic");
    await update;
    await afterMicrotasks();
    expect(reads).toBe(1);

    read.resolve("robot");
    await afterMicrotasks();
    expect(published).toEqual(["organic", "robot"]);
  });
});
