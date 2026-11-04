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
    expect(stopLocalStackItem({ mode: "new", stackRunning: true, stop: vi.fn() }).visible).toBe(
      true,
    );
  });

  it("keeps the off-switch working for a stack left running after a server switch", () => {
    const stop = vi.fn();
    const item = stopLocalStackItem({ mode: "existing", stackRunning: true, stop });
    expect(item.visible).toBe(true);
    item.click?.(undefined as never, undefined as never, undefined as never);
    expect(stop).toHaveBeenCalledOnce();
  });

  it("hides the off-switch when no app-managed stack exists", () => {
    expect(
      stopLocalStackItem({ mode: "existing", stackRunning: false, stop: vi.fn() }).visible,
    ).toBe(false);
    expect(stopLocalStackItem({ mode: null, stackRunning: false, stop: vi.fn() }).visible).toBe(
      false,
    );
  });
});

describe("stack stop menu availability", () => {
  it("rebuilds the menu only when a lifecycle change flips the item", () => {
    let setup = { mode: "existing" as const, running: false };
    const rebuildMenu = vi.fn();
    const availability = new StackStopMenuAvailability(() => setup, rebuildMenu);

    availability.stackChanged();
    expect(rebuildMenu).not.toHaveBeenCalled();

    // A stack that started in the background, for instance from a setup closed mid-start.
    setup = { mode: "existing", running: true };
    availability.stackChanged();
    expect(rebuildMenu).toHaveBeenCalledOnce();
    availability.stackChanged();
    expect(rebuildMenu).toHaveBeenCalledOnce();

    setup = { mode: "existing", running: false };
    availability.stackChanged();
    expect(rebuildMenu).toHaveBeenCalledTimes(2);
  });

  it("stays quiet through a start's progress while availability holds", () => {
    const rebuildMenu = vi.fn();
    const availability = new StackStopMenuAvailability(
      () => ({ mode: "new" as const, running: true }),
      rebuildMenu,
    );
    for (let i = 0; i < 3; i++) availability.stackChanged();
    expect(rebuildMenu).toHaveBeenCalledOnce();
  });
});
