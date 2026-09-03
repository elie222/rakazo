import { describe, expect, it, vi } from "vitest";
import { installPreloadRecovery } from "./preload-recovery";

describe("preload recovery", () => {
  it("reloads once when a stale lazy chunk fails", () => {
    let listener: EventListener | undefined;
    const store = new Map<string, string>();
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
    const first = new Event("vite:preloadError", { cancelable: true });
    listener?.(first);
    listener?.(new Event("vite:preloadError", { cancelable: true }));

    expect(first.defaultPrevented).toBe(true);
    expect(reload).toHaveBeenCalledOnce();
  });
});
