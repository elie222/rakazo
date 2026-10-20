import { describe, expect, it, vi } from "vitest";
import { installPreloadRecovery, readPreloadRecoveryState } from "./preload-recovery";

describe("preload recovery", () => {
  function createTarget(store = new Map<string, string>(), onLine = true, state = {}) {
    let listener: EventListener | undefined;
    const reload = vi.fn();
    const target = {
      addEventListener: (_type: string, next: EventListener) => {
        listener = next;
      },
      clearTimeout: vi.fn(),
      removeEventListener: vi.fn(),
      location: { reload },
      navigator: { onLine },
      sessionStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => store.set(key, value),
        removeItem: (key: string) => store.delete(key),
      },
      setTimeout: vi.fn(() => 1),
    };
    installPreloadRecovery(target as unknown as Window, () => state);
    return { listener: () => listener, reload };
  }

  it("arms overlay restoration only for an automatic reload and consumes it once", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      removeItem: (key: string) => {
        store.delete(key);
      },
    };
    const state = { settings: true, integrations: false };
    const { listener } = createTarget(store, true, state);
    expect(readPreloadRecoveryState(storage)).toEqual({});
    listener()?.(new Event("vite:preloadError", { cancelable: true }));
    expect(readPreloadRecoveryState(storage)).toEqual(state);
    expect(readPreloadRecoveryState(storage)).toEqual({});
    expect(store.get("rk:preload-recovery")).toBe("1");
  });

  it("does not block startup when session storage access is restricted", () => {
    const target = {
      get sessionStorage(): Storage {
        throw new Error("Storage is restricted");
      },
    };
    expect(() => installPreloadRecovery(target as Window)()).not.toThrow();
  });

  it("ignores malformed recovery state", () => {
    const store = new Map([["rk:preload-recovery-state", "invalid"]]);
    expect(
      readPreloadRecoveryState({
        getItem: (key: string) => store.get(key) ?? null,
        removeItem: (key: string) => {
          store.delete(key);
        },
      }),
    ).toEqual({});
    expect(store.size).toBe(0);
  });

  it("reloads once without suppressing another failure during navigation", () => {
    const { listener, reload } = createTarget();
    const first = new Event("vite:preloadError", { cancelable: true });
    const second = new Event("vite:preloadError", { cancelable: true });
    listener()?.(first);
    listener()?.(second);

    expect(first.defaultPrevented).toBe(true);
    expect(second.defaultPrevented).toBe(false);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("does not suppress a new failure after the recovery reload", () => {
    const store = new Map([["rk:preload-recovery", "1"]]);
    const { listener, reload } = createTarget(store);
    const nextPageFailure = new Event("vite:preloadError", { cancelable: true });

    listener()?.(nextPageFailure);

    expect(nextPageFailure.defaultPrevented).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("leaves an offline failure to the error boundary instead of reloading", () => {
    const { listener, reload } = createTarget(new Map(), false);
    const offlineFailure = new Event("vite:preloadError", { cancelable: true });

    listener()?.(offlineFailure);

    expect(offlineFailure.defaultPrevented).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});
