// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  scheme: "light" as "light" | "dark",
  composeLoads: 0,
  host: vi.fn(),
  pressable: vi.fn(),
  view: vi.fn(),
  switch: vi.fn(),
  fallback: vi.fn(),
}));
vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  Pressable: (props: { children: ReactNode }) => {
    state.pressable(props);
    return props.children;
  },
  View: (props: { children: ReactNode }) => {
    state.view(props);
    return props.children;
  },
  Switch: (props: unknown) => {
    state.fallback(props);
    return null;
  },
}));
vi.mock("./native", () => ({
  useResolvedAppearance: () => state.scheme,
  systemGreen: (scheme: string) => (scheme === "dark" ? "#30D158" : "#34C759"),
}));
vi.mock("@expo/ui/jetpack-compose", () => {
  state.composeLoads++;
  return {
    Host: (props: { children: ReactNode }) => {
      state.host(props);
      return props.children;
    },
    Switch: (props: unknown) => {
      state.switch(props);
      return null;
    },
  };
});
vi.mock("@expo/ui/jetpack-compose/modifiers", () => ({
  alpha: (value: unknown) => ({ name: "alpha", value }),
}));

let root: Root;
let container: HTMLDivElement;
const props = { value: true, accessibilityLabel: "Notifications", onValueChange: vi.fn() };

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.scheme = "light";
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function load(missing?: string) {
  const getViewConfig = vi.fn((_module, view) => (view === missing ? null : {}));
  vi.stubGlobal("expo", { getViewConfig });
  const { NativeSwitch } = await import("../components/native-switch");
  async function render(overrides = {}) {
    await act(async () => root.render(<NativeSwitch {...props} {...overrides} />));
    await act(async () => vi.dynamicImportSettled());
  }
  return { render, getViewConfig };
}

describe("guarded Android Compose switch", () => {
  it.each(["HostView", "SwitchView"])(
    "preserves the original fallback without loading Compose when %s is missing",
    async (missing) => {
      const loads = state.composeLoads;
      const { render, getViewConfig } = await load(missing);
      const trackColor = { false: "grey", true: "blue" };
      await render({
        disabled: true,
        accessibilityHint: "Updates",
        trackColor,
        thumbColor: "white",
      });
      expect(state.composeLoads).toBe(loads);
      expect(state.switch).not.toHaveBeenCalled();
      expect(getViewConfig).toHaveBeenCalledWith("ExpoUI", missing);
      expect(state.fallback.mock.lastCall?.[0]).toEqual({
        ...props,
        disabled: true,
        accessibilityHint: "Updates",
        trackColor,
        thumbColor: "white",
      });
    },
  );

  it.each([
    ["light", "#34C759", "#7676801F", "#F2F2F1", "#6C6C70"],
    ["dark", "#30D158", "#7676803D", "#EBEBF599", "transparent"],
  ] as const)(
    "uses green and neutral colors in %s with a compact host",
    async (scheme, green, track, thumb, border) => {
      state.scheme = scheme;
      const { render, getViewConfig } = await load();
      await render();
      expect(getViewConfig.mock.calls).toEqual([
        ["ExpoUI", "HostView"],
        ["ExpoUI", "SwitchView"],
      ]);
      expect(state.host.mock.lastCall?.[0]).toMatchObject({
        colorScheme: scheme,
        style: { width: 56, height: 32, flexShrink: 0 },
      });
      expect(state.switch.mock.lastCall?.[0]).toMatchObject({
        value: true,
        enabled: true,
        colors: {
          checkedTrackColor: green,
          checkedThumbColor: "#FFFFFF",
          uncheckedTrackColor: track,
          uncheckedThumbColor: thumb,
          uncheckedBorderColor: border,
          disabledCheckedTrackColor: green,
          disabledUncheckedTrackColor: track,
          disabledUncheckedBorderColor: border,
        },
        modifiers: [{ name: "alpha", value: 1 }],
      });
    },
  );

  it("maps disabled state, label and hint and honors color overrides", async () => {
    const { render } = await load();
    await render({
      disabled: true,
      accessibilityHint: "Updates",
      trackColor: { true: "blue", false: "grey" },
      thumbColor: "white",
      tintColor: "red",
    });
    expect(state.switch.mock.lastCall?.[0]).toMatchObject({
      enabled: false,
      colors: {
        checkedTrackColor: "blue",
        uncheckedTrackColor: "grey",
        checkedThumbColor: "white",
        uncheckedThumbColor: "white",
        disabledCheckedTrackColor: "blue",
        disabledUncheckedTrackColor: "grey",
      },
      modifiers: [{ name: "alpha", value: 0.38 }],
    });
    expect(state.pressable.mock.lastCall?.[0]).toMatchObject({
      accessible: true,
      accessibilityRole: "switch",
      accessibilityLabel: "Notifications",
      accessibilityHint: "Updates",
      accessibilityState: { checked: true, disabled: true },
      disabled: true,
      onPress: undefined,
    });
    await render({ tintColor: "red", trackColor: { false: "grey" } });
    expect(state.switch.mock.lastCall?.[0].colors.checkedTrackColor).toBe("red");
  });

  it("keeps the parent value when a change is rejected and follows accepted changes and reverts", async () => {
    const { render } = await load();
    await render({ value: false });
    expect(state.view.mock.lastCall?.[0]).toMatchObject({
      importantForAccessibility: "no-hide-descendants",
      pointerEvents: "none",
    });
    expect(state.pressable.mock.lastCall?.[0]).toMatchObject({
      accessible: true,
      accessibilityRole: "switch",
      accessibilityLabel: "Notifications",
      accessibilityState: { checked: false, disabled: false },
    });
    act(() => state.pressable.mock.lastCall?.[0].onPress());
    expect(props.onValueChange).toHaveBeenCalledWith(true);
    expect(state.switch.mock.lastCall?.[0].value).toBe(false);
    await render({ value: false });
    expect(state.switch.mock.lastCall?.[0].value).toBe(false);
    await render({ value: true });
    expect(state.switch.mock.lastCall?.[0].value).toBe(true);
    expect(state.pressable.mock.lastCall?.[0].accessibilityState.checked).toBe(true);
    act(() => state.pressable.mock.lastCall?.[0].onPress());
    expect(props.onValueChange).toHaveBeenLastCalledWith(false);
    await render({ value: false });
    expect(state.switch.mock.lastCall?.[0].value).toBe(false);
  });
});
