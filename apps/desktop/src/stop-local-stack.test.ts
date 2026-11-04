import { describe, expect, it, vi } from "vitest";
import { stackStopAvailable, stopLocalStackItem } from "./stop-local-stack.js";

describe("stop local stack menu item", () => {
  it("offers the off-switch while the app is connected to its local stack", () => {
    expect(stackStopAvailable("new", "idle")).toBe(true);
    expect(stackStopAvailable("new", "ready")).toBe(true);
    expect(stopLocalStackItem({ mode: "new", phase: "preparing", stop: vi.fn() }).visible).toBe(
      true,
    );
  });

  it("keeps the off-switch working for a stack left running after a server switch", () => {
    const stop = vi.fn();
    const item = stopLocalStackItem({ mode: "existing", phase: "ready", stop });
    expect(item.visible).toBe(true);
    item.click?.(undefined as never, undefined as never, undefined as never);
    expect(stop).toHaveBeenCalledOnce();
  });

  it("hides the off-switch when no app-managed stack exists", () => {
    expect(stopLocalStackItem({ mode: "existing", phase: "idle", stop: vi.fn() }).visible).toBe(
      false,
    );
    expect(stopLocalStackItem({ mode: null, phase: "idle", stop: vi.fn() }).visible).toBe(false);
  });
});
