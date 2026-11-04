// @vitest-environment jsdom

import { SCREEN_RECONNECT_STABLE_MS } from "@rakazo/core";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

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
