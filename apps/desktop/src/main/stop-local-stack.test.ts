import type { DesktopLocalStackPhase, DesktopLocalStackState } from "@rakazo/contracts";
import { deferred, flush } from "@rakazo/core/test-async";
import { describe, expect, it, vi } from "vitest";
import { reportDesktopError } from "./monitoring.js";
import {
  quitAndStopBotsItem,
  StackStopMenuAvailability,
  stackStopAvailable,
  stopStackLeftBehind,
} from "./stop-local-stack.js";

vi.mock("./monitoring.js", () => ({ reportDesktopError: vi.fn() }));

const stopped = { phase: "idle" } as DesktopLocalStackState;
const failed = { phase: "failed" } as DesktopLocalStackState;

function item(overrides: Partial<Parameters<typeof quitAndStopBotsItem>[0]> = {}) {
  return quitAndStopBotsItem({
    mode: "existing",
    stackRunning: true,
    stop: vi.fn(async () => stopped),
    quit: vi.fn(),
    rebuildMenu: vi.fn(),
    ...overrides,
  });
}

function click(menuItem: ReturnType<typeof quitAndStopBotsItem>) {
  menuItem.click?.(undefined as never, undefined as never, undefined as never);
}

describe("quit and stop bots menu item", () => {
  it("is offered while the app is connected to its local stack", () => {
    expect(stackStopAvailable("new", false)).toBe(true);
    expect(stackStopAvailable("new", true)).toBe(true);
    expect(item({ mode: "new" }).visible).toBe(true);
  });

  it("is hidden when no app-managed stack exists", () => {
    expect(item({ stackRunning: false }).visible).toBe(false);
    expect(item({ mode: null, stackRunning: false }).visible).toBe(false);
  });

  it("stops before quitting even when no stack is flagged, since an older version's may run", async () => {
    const stop = vi.fn(async () => stopped);
    const quit = vi.fn();
    click(item({ mode: "new", stackRunning: false, stop, quit }));
    expect(stop).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());
  });

  it("quits only after the stack has stopped", async () => {
    const done = deferred<DesktopLocalStackState>();
    const quit = vi.fn();
    const rebuildMenu = vi.fn();
    click(item({ stop: () => done.promise, quit, rebuildMenu }));
    // Immediate rebuild first: deactivating computer access changes other menu items.
    expect(rebuildMenu).toHaveBeenCalledOnce();
    await flush();
    expect(quit).not.toHaveBeenCalled();

    done.resolve(stopped);
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());
  });

  it("stays open after a failed stop", async () => {
    const quit = vi.fn();
    const rebuildMenu = vi.fn();
    click(item({ stop: async () => failed, quit, rebuildMenu }));
    await vi.waitFor(() => expect(rebuildMenu).toHaveBeenCalledTimes(2));
    expect(quit).not.toHaveBeenCalled();
  });

  it("reports a rejected stop and stays open, without an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    const quit = vi.fn();
    const rebuildMenu = vi.fn();

    try {
      click(item({ stop: () => Promise.reject(new Error("docker went away")), quit, rebuildMenu }));
      await flush();
      expect(rebuildMenu).toHaveBeenCalledTimes(2);
      expect(quit).not.toHaveBeenCalled();
      expect(vi.mocked(reportDesktopError)).toHaveBeenCalledWith(expect.any(Error), "desktop.menu");
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      vi.mocked(reportDesktopError).mockClear();
    }
  });
});

describe("stop stack left behind", () => {
  function stack(
    running: boolean,
    stop = vi.fn(async () => stopped),
    phase: DesktopLocalStackPhase = "idle",
  ) {
    return {
      managedStackRunning: () => running,
      state: () => ({ phase }) as DesktopLocalStackState,
      stop,
      webUrl: () => "http://127.0.0.1:45173",
    };
  }

  it("stops a running stack once the app switches to another server", async () => {
    const running = stack(true);
    const rebuildMenu = vi.fn();
    stopStackLeftBehind({
      previousMode: "existing",
      mode: "existing",
      serverUrl: "https://rakazo.example",
      stack: running,
      rebuildMenu,
    });
    expect(running.stop).toHaveBeenCalledOnce();
    // A stop that changes no phase still refreshes the menu once it settles.
    await vi.waitFor(() => expect(rebuildMenu).toHaveBeenCalledOnce());
  });

  it("always stops when leaving This computer, even with nothing flagged", () => {
    const unflagged = stack(false, undefined, "failed");
    stopStackLeftBehind({
      previousMode: "new",
      mode: "existing",
      serverUrl: "https://rakazo.example",
      stack: unflagged,
      rebuildMenu: vi.fn(),
    });
    expect(unflagged.stop).toHaveBeenCalledOnce();
  });

  it("keeps the stack when its own address is chosen as an existing server", () => {
    const own = stack(true);
    stopStackLeftBehind({
      previousMode: "new",
      mode: "existing",
      serverUrl: "http://127.0.0.1:45173/",
      stack: own,
      rebuildMenu: vi.fn(),
    });
    expect(own.stop).not.toHaveBeenCalled();
  });

  it("stops a start that has not launched anything yet", () => {
    const pulling = stack(false, undefined, "pulling");
    stopStackLeftBehind({
      previousMode: "existing",
      mode: "existing",
      serverUrl: "https://rakazo.example",
      stack: pulling,
      rebuildMenu: vi.fn(),
    });
    expect(pulling.stop).toHaveBeenCalledOnce();
  });

  it("leaves the stack alone on This computer or when none is running", () => {
    const connected = stack(true);
    const idle = stack(false);
    const missing = stack(false, undefined, "docker-missing");
    stopStackLeftBehind({
      previousMode: "existing",
      mode: "existing",
      serverUrl: "https://rakazo.example",
      stack: missing,
      rebuildMenu: vi.fn(),
    });
    expect(missing.stop).not.toHaveBeenCalled();
    stopStackLeftBehind({
      previousMode: "new",
      mode: "new",
      serverUrl: "http://127.0.0.1:45173",
      stack: connected,
      rebuildMenu: vi.fn(),
    });
    stopStackLeftBehind({
      previousMode: "existing",
      mode: "existing",
      serverUrl: "https://rakazo.example",
      stack: idle,
      rebuildMenu: vi.fn(),
    });
    expect(connected.stop).not.toHaveBeenCalled();
    expect(idle.stop).not.toHaveBeenCalled();
  });

  it("reports a rejected stop", async () => {
    const rebuildMenu = vi.fn();
    const rejecting = stack(
      true,
      vi.fn(() => Promise.reject(new Error("docker went away"))),
    );
    try {
      stopStackLeftBehind({
        previousMode: "existing",
        mode: "existing",
        serverUrl: "https://rakazo.example",
        stack: rejecting,
        rebuildMenu,
      });
      await vi.waitFor(() => expect(rebuildMenu).toHaveBeenCalledOnce());
      expect(vi.mocked(reportDesktopError)).toHaveBeenCalledWith(expect.any(Error), "desktop.ipc");
    } finally {
      vi.mocked(reportDesktopError).mockClear();
    }
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

  it("rebuilds when a confirmed reuse changes no phase", () => {
    const rebuildMenu = vi.fn();
    const availability = new StackStopMenuAvailability(rebuildMenu);

    availability.stackChanged("idle");
    expect(rebuildMenu).toHaveBeenCalledOnce();
    availability.reuseConfirmed();
    expect(rebuildMenu).toHaveBeenCalledTimes(2);
  });
});
