import { describe, expect, it, vi } from "vitest";
import { installPreloadRecovery } from "./preload-recovery";

describe("preload recovery", () => {
  function createTarget(store = new Map<string, string>()) {
    let listener: EventListener | undefined;
    const reload = vi.fn();
    const target = {
      addEventListener: (_type: string, next: EventListener) => {
        listener = next;
      },
      clearTimeout: vi.fn(),
      removeEventListener: vi.fn(),
      location: { reload },
      sessionStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => store.set(key, value),
        removeItem: (key: string) => store.delete(key),
      },
      setTimeout: vi.fn(() => 1),
    };
    installPreloadRecovery(target as unknown as Window);
    return { listener: () => listener, reload };
  }

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
});
