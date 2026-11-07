// @vitest-environment jsdom

import { COMPUTER_ALLOWANCE_USED_ERROR } from "@rakazo/contracts";
import { SCREEN_RECONNECT_STABLE_MS } from "@rakazo/core";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SCREEN_FRAME_LOAD_TIMEOUT_MS } from "../../lib/computer-screen";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) => String.raw(parts, ...values),
  }),
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: (props: ComponentProps<"button">) => <button type="button" {...props} />,
  Spinner: () => null,
}));
vi.mock("../../components/ComputerMaintenanceActions", () => ({
  ComputerMaintenanceActions: () => null,
}));

import type { ComputerState } from "./use-computer";
import { useComputerControls, useComputerState } from "./use-computer";

let container: HTMLDivElement;
let root: Root;
let state: ComputerState;
let codes = 0;
let screenUrlFactory: () => string = () =>
  `wuying://desktop?desktop_id=ecd-1&region_id=cn-hangzhou&auth_code=code-${++codes}&view_only=true`;
const screenUrl = vi.fn(async () => ({ url: screenUrlFactory() }));

/** The hook with the frame the panel draws: gone while an error replaces the screen. */
function Harness() {
  state = useComputerState({
    rpc: { computer: { screenUrl } } as never,
    panel: "computer",
    activeId: "bot-1",
    activeBotId: { current: "bot-1" },
  });
  return state.screenUrl && !state.screenLoadError ? (
    <iframe key={state.screenFrameKey} ref={state.setScreenFrame} title="screen" />
  ) : null;
}

const code = () => /auth_code=([^&]+)/.exec(state.screenUrl ?? "")?.[1] ?? null;

async function read() {
  await act(async () => {
    await state.refreshComputerScreen("bot-1");
  });
}

async function report(rakazoScreen: string) {
  const frame = container.querySelector("iframe");
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent("message", { data: { rakazoScreen }, source: frame?.contentWindow }),
    );
  });
}

beforeEach(async () => {
  vi.useFakeTimers();
  codes = 0;
  screenUrlFactory = () =>
    `wuying://desktop?desktop_id=ecd-1&region_id=cn-hangzhou&auth_code=code-${++codes}&view_only=true`;
  screenUrl.mockClear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 204 })),
  );
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("shows a Wuying screen's failure and waits for Retry rather than spend another code", async () => {
  await read();
  expect(code()).toBe("code-1");
  await report("connecting");
  await report("failed");
  expect(state.screenLoadError).toBe("Could not connect to the computer screen");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  await read();
  expect(state.screenUrl).toBeNull();
  expect(container.querySelector("iframe")).toBeNull();
});

it("keeps a live Wuying frame's code, and reconnects every drop with a fresh code", async () => {
  await read();
  await report("connected");
  await read();
  expect(code()).toBe("code-1");
  await report("disconnected");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  expect(code()).toBe("code-3");
  await report("connected");
  // The connection stays up; the next drop is a new restart, with the first delay again.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(SCREEN_RECONNECT_STABLE_MS);
  });
  await report("disconnected");
  expect(state.screenLoadError).toBeNull();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  expect(code()).toBe("code-4");
  expect(screenUrl).toHaveBeenCalledTimes(4);
});

it("shows a Wuying screen's error only after its reloads stop connecting", async () => {
  await read();
  await report("connected");
  await report("disconnected");
  // The reload races the restart and never connects; each failure loads a fresh code, waiting
  // longer each time, until the retries run out and the error waits for Retry.
  for (const wait of [1_000, 2_000, 4_000]) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(wait);
    });
    expect(state.screenLoadError).toBeNull();
    await report("failed");
  }
  expect(state.screenLoadError).toBe("Could not connect to the computer screen");
});

it("never caches a Wuying login code", async () => {
  await read();
  expect(state.computerCacheRef.current.get("bot-1")?.screenUrl).toBeNull();
});

it("reconnects a proxied screen whose reload raced a restart, without the error", async () => {
  screenUrlFactory = () => "/novnc/session/view/1.restart/vnc.html";
  await read();
  await report("connected");
  // The screen restarts under the viewer: the proxy closes the socket, the app reloads the
  // page, and the screen server refuses that reload's connection once.
  await report("disconnected");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  await report("failed");
  expect(state.screenLoadError).toBeNull();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_000);
  });
  await report("connected");
  expect(state.screenLoadError).toBeNull();
  expect(container.querySelector("iframe")).not.toBeNull();
});

it("shows a proxied screen's error only after its reloads stop connecting", async () => {
  screenUrlFactory = () => "/novnc/session/view/1.stuck/vnc.html";
  await read();
  await report("connected");
  await report("disconnected");
  for (const wait of [1_000, 2_000, 4_000]) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(wait);
    });
    expect(state.screenLoadError).toBeNull();
    await report("failed");
  }
  expect(state.screenLoadError).toBe("Could not connect to the computer screen");
  expect(container.querySelector("iframe")).toBeNull();
});

it("keeps one reconnect while its screen read is still pending", async () => {
  await read();
  await report("connected");
  // The drop's screen read answers slowly; the dying page reports the same drop again, and
  // that second read would fail.
  let release: (() => void) | undefined;
  screenUrl.mockImplementationOnce(
    () =>
      new Promise<{ url: string }>((resolve) => {
        release = () => resolve({ url: screenUrlFactory() });
      }),
  );
  screenUrl.mockImplementationOnce(async () => {
    throw new Error("screen read failed");
  });
  await report("disconnected");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  await report("failed");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  expect(screenUrl).toHaveBeenCalledTimes(2);
  expect(state.screenLoadError).toBeNull();
  // The one pending read completes with a fresh code, and the screen keeps it.
  await act(async () => {
    release?.();
  });
  expect(state.screenLoadError).toBeNull();
  expect(code()).toBe("code-2");
});

it("reconnects again after a reconnection cancels a queued retry", async () => {
  await read();
  await report("connected");
  await report("disconnected");
  // The SDK rejoined by itself, so the queued retry is cancelled without a read.
  await report("connected");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  expect(screenUrl).toHaveBeenCalledTimes(1);
  // A later drop still reconnects rather than waiting in a stuck hold.
  await report("disconnected");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_000);
  });
  expect(screenUrl).toHaveBeenCalledTimes(2);
  expect(code()).toBe("code-2");
  expect(state.screenLoadError).toBeNull();
});

it("reconnects again after its read ends on an already rejoined screen", async () => {
  await read();
  await report("connected");
  let release: (() => void) | undefined;
  screenUrl.mockImplementationOnce(
    () =>
      new Promise<{ url: string }>((resolve) => {
        release = () => resolve({ url: screenUrlFactory() });
      }),
  );
  await report("disconnected");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  // The provider rejoined the same session while the read was out; the completed read
  // keeps the live URL, so nothing re-runs the effect.
  await report("connected");
  await act(async () => {
    release?.();
  });
  expect(code()).toBe("code-1");
  // A later drop still reconnects.
  await report("disconnected");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_000);
  });
  expect(screenUrl).toHaveBeenCalledTimes(3);
  expect(code()).toBe("code-3");
  expect(state.screenLoadError).toBeNull();
});

it("shows the error when a reconnect read never settles", async () => {
  await read();
  await report("connected");
  let settle: ((value: { url: string }) => void) | undefined;
  screenUrl.mockImplementationOnce(
    () =>
      new Promise<{ url: string }>((resolve) => {
        settle = resolve;
      }),
  );
  await report("disconnected");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  expect(state.screenLoadError).toBeNull();
  // The read gets the same silence budget a framed screen has; past it the dropped screen
  // shows the error with Retry instead of waiting forever.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(SCREEN_FRAME_LOAD_TIMEOUT_MS);
  });
  expect(state.screenLoadError).toBe("Could not connect to the computer screen");
  // An answer that arrives after the deadline does not commit: the screen keeps waiting
  // for Retry.
  await act(async () => {
    settle?.({ url: screenUrlFactory() });
  });
  expect(code()).toBeNull();
  expect(state.screenLoadError).toBe("Could not connect to the computer screen");
});

it("leaves a reconnected screen showing when its hung read runs out of time", async () => {
  await read();
  await report("connected");
  screenUrl.mockImplementationOnce(() => new Promise<{ url: string }>(() => undefined));
  await report("disconnected");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  // The provider rejoined while the read hung; the screen keeps showing, and the deadline
  // releases the hold without an error.
  await report("connected");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(SCREEN_FRAME_LOAD_TIMEOUT_MS);
  });
  expect(state.screenLoadError).toBeNull();
  // A later drop reconnects again.
  screenUrl.mockImplementationOnce(async () => ({ url: screenUrlFactory() }));
  await report("disconnected");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  expect(screenUrl).toHaveBeenCalledTimes(3);
  expect(code()).toBe("code-2");
  expect(state.screenLoadError).toBeNull();
});

it("keeps a newer read's answer when the hung reconnect read runs out of time", async () => {
  await read();
  await report("connected");
  screenUrl.mockImplementationOnce(() => new Promise<{ url: string }>(() => undefined));
  await report("disconnected");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  await report("connected");
  // A newer read, such as a takeover's, starts just before the hung read's deadline and is
  // itself slow.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(14_000);
  });
  const takeoverUrl = `wuying://desktop?desktop_id=ecd-1&region_id=cn-hangzhou&auth_code=takeover&view_only=false`;
  let answerB: ((value: { url: string }) => void) | undefined;
  screenUrl.mockImplementationOnce(
    () =>
      new Promise<{ url: string }>((resolve) => {
        answerB = (value) => resolve(value);
      }),
  );
  await act(async () => {
    void state.refreshComputerScreen("bot-1");
  });
  // The hung read's deadline fires while the newer read is still out.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  await act(async () => {
    answerB?.({ url: takeoverUrl });
  });
  expect(state.screenUrl).toBe(takeoverUrl);
  expect(state.screenLoadError).toBeNull();
});

it("closes the computer view on Escape, but not on the Escape that ends an IME composition", async () => {
  function Controls() {
    state = useComputerState({
      rpc: {} as never,
      panel: null,
      activeId: undefined,
      activeBotId: { current: undefined },
    });
    useComputerControls({
      rpc: {} as never,
      state,
      panel: null,
      active: undefined,
      bots: [],
      botsRef: { current: [] },
      activeBotId: { current: undefined },
      activeGroupId: { current: undefined },
      runStatus: undefined,
      sandboxProvider: undefined,
      refreshThread: vi.fn(),
      refreshGroupThread: vi.fn(),
      onUpgrade: vi.fn(),
    });
    // Stands in for the view's "Teach a task" goal box, whose popover lets a composing Escape bubble.
    return <textarea aria-label="Goal" />;
  }
  await act(async () => root.render(<Controls />));
  await act(async () => state.setComputerOpen(true));
  const goal = container.querySelector("textarea")!;
  const press = (init: KeyboardEventInit = {}) =>
    act(async () => {
      goal.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, ...init }));
    });
  await press({ isComposing: true });
  await press({ keyCode: 229 });
  expect(state.computerOpen).toBe(true);
  await press();
  expect(state.computerOpen).toBe(false);
});

it("offers Upgrade instead of a retry once the computer hours are spent", async () => {
  const onUpgrade = vi.fn();
  function Controls() {
    state = useComputerState({
      rpc: {} as never,
      panel: null,
      activeId: undefined,
      activeBotId: { current: undefined },
    });
    const controls = useComputerControls({
      rpc: {} as never,
      state,
      panel: null,
      active: undefined,
      bots: [],
      botsRef: { current: [] },
      activeBotId: { current: undefined },
      activeGroupId: { current: undefined },
      runStatus: undefined,
      sandboxProvider: undefined,
      refreshThread: vi.fn(),
      refreshGroupThread: vi.fn(),
      onUpgrade,
    });
    return <>{controls.computerScreenError}</>;
  }
  await act(async () => root.render(<Controls />));
  await act(async () => state.setComputerError(COMPUTER_ALLOWANCE_USED_ERROR));
  const buttons = [...container.querySelectorAll("button")].map((button) => button.textContent);
  expect(buttons).toEqual(["Upgrade"]);
  await act(async () => container.querySelector("button")!.click());
  expect(onUpgrade).toHaveBeenCalledOnce();
  await act(async () => state.commitComputer({ state: "running", kind: "browser" } as never));
  expect(container.textContent).not.toContain("Upgrade");
});
