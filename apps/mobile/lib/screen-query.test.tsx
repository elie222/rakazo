// @vitest-environment jsdom
import { flush } from "@rakazo/core/test-async";
import { act, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { queryClient, rpcQuery } from "./query";
import { useScreenQuery } from "./screen-query";

const state = vi.hoisted(() => ({ rpc: vi.fn(), foreground: true }));
vi.mock("./api", () => ({
  currentApiBase: () => "https://app.example.test",
  selectedSpaceId: () => "space-fixture",
  captureApiRequestContext: async () => ({ apiBase: "https://app.example.test", headers: {} }),
  rpc: state.rpc,
}));
vi.mock("./session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("./app-foreground", () => ({ useAppForeground: () => state.foreground }));
vi.mock("expo-router", () => ({
  useFocusEffect: (effect: () => void) => useEffect(effect, [effect]),
}));

type Options = { enabled?: boolean; onForeground?: boolean };
function Screen({ focused, ...options }: { focused: boolean } & Options) {
  return focused ? <Focused {...options} /> : null;
}
function Focused(options: Options) {
  const { data } = useScreenQuery(rpcQuery("voice/status"), options);
  return <p>{String(data)}</p>;
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  queryClient.clear();
  state.foreground = true;
  state.rpc.mockReset().mockResolvedValueOnce("first").mockResolvedValue("second");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(props: { focused: boolean } & Options) {
  await act(async () => root.render(<Screen {...props} />));
  await act(flush);
}

it("reads once on opening, and again each time the screen gains focus", async () => {
  await render({ focused: true });
  expect(state.rpc).toHaveBeenCalledTimes(1);
  expect(container.textContent).toBe("first");
  await render({ focused: false });
  await render({ focused: true });
  expect(state.rpc).toHaveBeenCalledTimes(2);
  expect(container.textContent).toBe("second");
});

it("reads again when the app comes back to the foreground", async () => {
  await render({ focused: true });
  state.foreground = false;
  await render({ focused: true });
  expect(state.rpc).toHaveBeenCalledTimes(1);
  state.foreground = true;
  await render({ focused: true });
  expect(state.rpc).toHaveBeenCalledTimes(2);
  expect(container.textContent).toBe("second");
});

it("reads on focus only, not on return to the foreground, when asked to", async () => {
  await render({ focused: true, onForeground: false });
  state.foreground = false;
  await render({ focused: true, onForeground: false });
  state.foreground = true;
  await render({ focused: true, onForeground: false });
  expect(state.rpc).toHaveBeenCalledTimes(1);
  await render({ focused: false, onForeground: false });
  await render({ focused: true, onForeground: false });
  expect(state.rpc).toHaveBeenCalledTimes(2);
});

it("does not read while disabled", async () => {
  await render({ focused: true, enabled: false });
  expect(state.rpc).not.toHaveBeenCalled();
  await render({ focused: true, enabled: true });
  expect(state.rpc).toHaveBeenCalledTimes(1);
});

it("joins a read already in flight instead of restarting it", async () => {
  await render({ focused: true });
  await render({ focused: false });
  await queryClient.invalidateQueries({ refetchType: "none" });
  await render({ focused: true });
  expect(state.rpc).toHaveBeenCalledTimes(2);
  expect(container.textContent).toBe("second");
});
