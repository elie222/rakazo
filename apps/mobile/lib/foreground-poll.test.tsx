// @vitest-environment jsdom

import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useForegroundPoll } from "./foreground-poll";

const app = vi.hoisted(() => ({
  state: "active" as string,
  listeners: new Set<(state: string) => void>(),
}));

vi.mock("react-native", () => ({
  AppState: {
    get currentState() {
      return app.state;
    },
    addEventListener: (_event: string, listener: (state: string) => void) => {
      app.listeners.add(listener);
      return { remove: () => app.listeners.delete(listener) };
    },
  },
}));

function Harness({ run, enabled }: { run: () => Promise<unknown>; enabled: boolean }) {
  useForegroundPoll(run, 1_000, enabled);
  return null;
}

describe("useForegroundPoll", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    app.state = "active";
    app.listeners.clear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("runs immediately and never overlaps a slow poll", async () => {
    let resolve!: () => void;
    const run = vi.fn(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    act(() => root.render(<Harness enabled run={run} />));
    await act(async () => {});

    expect(run).toHaveBeenCalledOnce();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(run).toHaveBeenCalledOnce();

    resolve();
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it.each(["foreground", "enabled"])(
    "waits for a pending poll across %s changes",
    async (change) => {
      let resolve!: () => void;
      const run = vi.fn(
        () =>
          new Promise<void>((done) => {
            resolve = done;
          }),
      );
      act(() => root.render(<Harness enabled run={run} />));
      expect(run).toHaveBeenCalledOnce();

      for (const active of [false, true]) {
        act(() => {
          if (change === "enabled") {
            root.render(<Harness enabled={active} run={run} />);
          } else {
            app.state = active ? "active" : "background";
            for (const listener of app.listeners) listener(app.state);
          }
        });
      }
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(run).toHaveBeenCalledOnce();

      await act(async () => resolve());
      expect(run).toHaveBeenCalledOnce();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(999);
      });
      expect(run).toHaveBeenCalledOnce();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(run).toHaveBeenCalledTimes(2);
    },
  );

  it("stops after a non-retryable failure", async () => {
    const run = vi.fn(async () => false);
    act(() => root.render(<Harness enabled run={run} />));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(run).toHaveBeenCalledOnce();
  });

  it("pauses in the background and runs once on return", async () => {
    const run = vi.fn(async () => undefined);
    act(() => root.render(<Harness enabled run={run} />));
    await act(async () => {});
    expect(run).toHaveBeenCalledOnce();

    app.state = "background";
    act(() => {
      for (const listener of app.listeners) listener("background");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(run).toHaveBeenCalledOnce();

    app.state = "active";
    act(() => {
      for (const listener of app.listeners) listener("active");
    });
    await act(async () => {});
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("stops when disabled", async () => {
    const run = vi.fn(async () => undefined);
    act(() => root.render(<Harness enabled run={run} />));
    await act(async () => {});

    act(() => root.render(<Harness enabled={false} run={run} />));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(run).toHaveBeenCalledOnce();
  });
});
