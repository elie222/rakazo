import { describe, expect, it, vi } from "vitest";
import {
  StackStopMenuAvailability,
  stackStopAvailable,
  stopLocalStackItem,
} from "./stop-local-stack.js";

describe("stop local stack menu item", () => {
  it("offers the off-switch while the app is connected to its local stack", () => {
    expect(stackStopAvailable("new", false)).toBe(true);
    expect(stackStopAvailable("new", true)).toBe(true);
    expect(
      stopLocalStackItem({ mode: "new", stackRunning: true, stop: vi.fn(), rebuildMenu: vi.fn() })
        .visible,
    ).toBe(true);
  });

  it("keeps the off-switch working for a stack left running after a server switch", () => {
    const stop = vi.fn();
    const item = stopLocalStackItem({
      mode: "existing",
      stackRunning: true,
      stop,
      rebuildMenu: vi.fn(),
    });
    expect(item.visible).toBe(true);
    item.click?.(undefined as never, undefined as never, undefined as never);
    expect(stop).toHaveBeenCalledOnce();
  });

  it("hides the off-switch when no app-managed stack exists", () => {
    expect(
      stopLocalStackItem({
        mode: "existing",
        stackRunning: false,
        stop: vi.fn(),
        rebuildMenu: vi.fn(),
      }).visible,
    ).toBe(false);
    expect(
      stopLocalStackItem({ mode: null, stackRunning: false, stop: vi.fn(), rebuildMenu: vi.fn() })
        .visible,
    ).toBe(false);
  });

  it("rebuilds the menu after a stop settles, including one that changes no phase", async () => {
    const rebuildMenu = vi.fn();
    let settle!: () => void;
    const stop = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    const item = stopLocalStackItem({ mode: "existing", stackRunning: true, stop, rebuildMenu });

    item.click?.(undefined as never, undefined as never, undefined as never);
    expect(stop).toHaveBeenCalledOnce();
    // Immediate rebuild first: deactivating computer access changes other menu items.
    expect(rebuildMenu).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(rebuildMenu).toHaveBeenCalledOnce();

    // A stack stopped outside the app settles without a phase transition; the menu follows.
    settle();
    await vi.waitFor(() => expect(rebuildMenu).toHaveBeenCalledTimes(2));
  });
});

describe("stack stop menu availability", () => {
  it("rebuilds on every phase transition, so an earlier cycle cannot hide a later start", () => {
    const rebuildMenu = vi.fn();
    const availability = new StackStopMenuAvailability(rebuildMenu);

    availability.stackChanged("ready");
    // Docker output churn pushes state changes without a phase transition.
    availability.stackChanged("ready");
    expect(rebuildMenu).toHaveBeenCalledOnce();

    availability.stackChanged("idle");
    // The server switched without a lifecycle event; a stack starts again in the background.
    availability.stackChanged("checking-docker");
    availability.stackChanged("pulling");

    expect(rebuildMenu).toHaveBeenCalledTimes(4);
  });
});
