// @vitest-environment jsdom

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
import { useComputerState } from "./use-computer";

let container: HTMLDivElement;
let root: Root;
let state: ComputerState;
let codes = 0;
const screenUrl = vi.fn(async () => ({
  url: `wuying://desktop?desktop_id=ecd-1&region_id=cn-hangzhou&auth_code=code-${++codes}&view_only=true`,
}));

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

it("keeps a live Wuying frame's code, and reconnects one drop with a fresh code", async () => {
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
  // A second drop within the allowance waits for Retry.
  await report("disconnected");
  expect(state.screenLoadError).toBe("The screen connection closed.");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  expect(screenUrl).toHaveBeenCalledTimes(3);
});

it("never caches a Wuying login code", async () => {
  await read();
  expect(state.computerCacheRef.current.get("bot-1")?.screenUrl).toBeNull();
});
