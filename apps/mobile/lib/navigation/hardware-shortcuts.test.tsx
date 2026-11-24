// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useHardwareEscape, useHardwareShortcuts } from "./hardware-shortcuts";

const native = vi.hoisted(() => ({
  dispatch: undefined as ((event: { key: string; presented: boolean }) => void) | undefined,
  navigate: vi.fn(),
  setThreadEscapeEnabled: vi.fn(),
}));
vi.mock("expo-modules-core", () => ({
  requireOptionalNativeModule: () => ({
    setThreadEscapeEnabled: native.setThreadEscapeEnabled,
    addListener: (_: string, listener: typeof native.dispatch) => {
      native.dispatch = listener;
      return {
        remove: () => {
          native.dispatch = undefined;
        },
      };
    },
  }),
}));
vi.mock("expo-router", async () => {
  const { useEffect } = await import("react");
  return {
    useFocusEffect: (effect: Parameters<typeof useEffect>[0]) => useEffect(effect, [effect]),
    useRouter: () => ({ navigate: native.navigate }),
  };
});
vi.mock("../api/session", () => ({ loadSessionToken: async () => "test-session" }));

let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(document.createElement("div"));
  native.navigate.mockClear();
  native.setThreadEscapeEnabled.mockClear();
});
afterEach(async () => {
  await act(() => root.unmount());
});

function Shortcuts({
  dismiss,
  stop,
  blocked = false,
}: {
  dismiss?: () => void;
  stop?: () => void;
  blocked?: boolean;
}) {
  useHardwareShortcuts(true, 0, blocked);
  useHardwareEscape("modal", dismiss ?? null);
  useHardwareEscape("thread", stop ?? null);
  return null;
}

it("closes the presented route without stopping its underlying thread", async () => {
  const dismiss = vi.fn();
  const stop = vi.fn();
  await act(async () => root.render(<Shortcuts dismiss={dismiss} stop={stop} />));

  act(() => native.dispatch?.({ key: "Escape", presented: true }));

  expect(dismiss).toHaveBeenCalledOnce();
  expect(stop).not.toHaveBeenCalled();
});

it("stops a thread on Escape when the navigator is not presenting a sheet", async () => {
  const stop = vi.fn();
  await act(async () => root.render(<Shortcuts stop={stop} />));

  act(() => native.dispatch?.({ key: "Escape", presented: false }));

  expect(stop).toHaveBeenCalledOnce();
});

it("keeps thread Escape registered while applying the latest stop action", async () => {
  const stop = vi.fn();
  await act(async () => root.render(<Shortcuts stop={() => {}} />));
  await act(async () => root.render(<Shortcuts stop={stop} />));

  act(() => native.dispatch?.({ key: "Escape", presented: false }));

  expect(native.setThreadEscapeEnabled).toHaveBeenCalledExactlyOnceWith(true);
  expect(stop).toHaveBeenCalledOnce();
});

it.each([
  ["k", "/search"],
  ["n", "/new-group"],
])("navigates on Command+%s", async (key, route) => {
  await act(async () => root.render(<Shortcuts />));

  act(() => native.dispatch?.({ key, presented: false }));

  expect(native.navigate).toHaveBeenCalledExactlyOnceWith(route);
});

it("keeps hardware shortcuts from leaving a blocking screen", async () => {
  const dismiss = vi.fn();
  await act(async () => root.render(<Shortcuts dismiss={dismiss} blocked />));

  act(() => {
    native.dispatch?.({ key: "Escape", presented: true });
    native.dispatch?.({ key: "k", presented: true });
    native.dispatch?.({ key: "n", presented: true });
  });

  expect(dismiss).not.toHaveBeenCalled();
  expect(native.navigate).not.toHaveBeenCalled();
});
