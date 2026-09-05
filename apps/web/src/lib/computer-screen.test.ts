import { describe, expect, it, vi } from "vitest";
import { loadComputerScreen } from "./computer-screen";

describe("computer screen requests", () => {
  it("shows connection failures and lets a successful retry clear them", async () => {
    const commit = vi.fn();
    const options = {
      isCurrent: () => true,
      commit,
      fallbackError: "Could not connect",
    };
    await loadComputerScreen({
      ...options,
      load: async () => {
        throw new Error("Control stream failed to start");
      },
    });
    expect(commit).toHaveBeenLastCalledWith({
      url: null,
      error: "Control stream failed to start",
    });

    await expect(
      loadComputerScreen({
        ...options,
        load: async () => ({ url: "https://screen.example/vnc.html" }),
      }),
    ).resolves.toBe("https://screen.example/vnc.html");
    expect(commit).toHaveBeenLastCalledWith({
      url: "https://screen.example/vnc.html",
      error: null,
    });
  });

  it.each(["success", "failure"])(
    "ignores a stale %s after a newer screen failure",
    async (outcome) => {
      let finish!: (screen: { url: string | null }) => void;
      let fail!: (error: Error) => void;
      const deferred = new Promise<{ url: string | null }>((resolve, reject) => {
        finish = resolve;
        fail = reject;
      });
      let current = 1;
      const commit = vi.fn();
      const stale = loadComputerScreen({
        load: () => deferred,
        isCurrent: () => current === 1,
        commit,
        fallbackError: "Could not connect",
      });
      current = 2;
      await loadComputerScreen({
        load: async () => {
          throw new Error("Latest connection failed");
        },
        isCurrent: () => current === 2,
        commit,
        fallbackError: "Could not connect",
      });
      if (outcome === "success") finish({ url: "https://stale.example/vnc.html" });
      else fail(new Error("Stale connection failed"));
      await expect(stale).resolves.toBeNull();
      expect(commit).toHaveBeenCalledExactlyOnceWith({
        url: null,
        error: "Latest connection failed",
      });
    },
  );

  it("uses the visible fallback for errors without a message", async () => {
    const commit = vi.fn();
    await loadComputerScreen({
      load: async () => Promise.reject(null),
      isCurrent: () => true,
      commit,
      fallbackError: "Could not connect",
    });
    expect(commit).toHaveBeenCalledExactlyOnceWith({ url: null, error: "Could not connect" });
  });
});
