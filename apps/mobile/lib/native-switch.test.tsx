// @vitest-environment jsdom

import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NativeSwitch as AndroidSwitch } from "../components/native-switch";
import { NativeSwitch as IosSwitch } from "../components/native-switch.ios";
import { setAppearancePreference } from "./appearance";

const system = vi.hoisted(() => ({ scheme: "light" as "light" | "dark" }));
const swiftToggle = vi.hoisted(() => vi.fn());
const swiftHost = vi.hoisted(() => vi.fn());
const androidSwitch = vi.hoisted(() => vi.fn());

vi.mock("react-native", () => ({
  Appearance: {
    getColorScheme: () => system.scheme,
    setColorScheme: () => undefined,
    addChangeListener: () => ({ remove: () => undefined }),
  },
  Platform: { OS: "ios" },
  Switch: (props: unknown) => {
    androidSwitch(props);
    return null;
  },
}));
vi.mock("expo-secure-store", () => ({ setItemAsync: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@expo/ui/swift-ui", () => ({
  Host: (props: { children: ReactNode }) => {
    swiftHost(props);
    return props.children;
  },
  Toggle: (props: unknown) => {
    swiftToggle(props);
    return null;
  },
}));
vi.mock("@expo/ui/swift-ui/modifiers", () =>
  Object.fromEntries(
    [
      "accessibilityHint",
      "accessibilityLabel",
      "disabled",
      "labelsHidden",
      "tint",
      "toggleStyle",
    ].map((name) => [name, (value: unknown) => ({ name, value })]),
  ),
);

const props = { value: true, accessibilityLabel: "Notifications", onValueChange: () => {} };

beforeEach(async () => {
  vi.clearAllMocks();
  system.scheme = "light";
  await setAppearancePreference("system");
});

describe("iOS switch tint", () => {
  it.each(["light", "dark"] as const)("leaves the system tint unset in %s", (scheme) => {
    system.scheme = scheme;
    renderToStaticMarkup(<IosSwitch {...props} />);
    expect(swiftHost.mock.lastCall?.[0].colorScheme).toBe(scheme);
    expect(
      swiftToggle.mock.lastCall?.[0].modifiers.filter(
        (modifier: { name: string }) => modifier.name === "tint",
      ),
    ).toEqual([]);
  });

  it.each([
    ["light", "dark"],
    ["dark", "light"],
  ] as const)("respects explicit app %s over system %s", async (preference, scheme) => {
    system.scheme = scheme;
    await setAppearancePreference(preference);
    renderToStaticMarkup(<IosSwitch {...props} />);
    expect(swiftHost.mock.lastCall?.[0].colorScheme).toBe(preference);
    expect(
      swiftToggle.mock.lastCall?.[0].modifiers.filter(
        (modifier: { name: string }) => modifier.name === "tint",
      ),
    ).toEqual([]);
  });

  it.each(["light", "dark"] as const)("respects an explicit tint in %s", (scheme) => {
    system.scheme = scheme;
    renderToStaticMarkup(<IosSwitch {...props} tintColor="red" />);
    const tints = swiftToggle.mock.lastCall?.[0].modifiers.filter(
      (modifier: { name: string }) => modifier.name === "tint",
    );
    expect(tints).toEqual([{ name: "tint", value: "red" }]);
  });
});

describe("Android switch colors", () => {
  it.each([
    ["light", "#34C759"],
    ["dark", "#30D158"],
  ] as const)(
    "defaults to green on and platform off/thumb in app %s",
    async (preference, green) => {
      system.scheme = preference === "light" ? "dark" : "light";
      await setAppearancePreference(preference);
      renderToStaticMarkup(<AndroidSwitch {...props} />);
      expect(androidSwitch.mock.lastCall?.[0].trackColor).toEqual({ true: green });
      expect(androidSwitch.mock.lastCall?.[0].thumbColor).toBeUndefined();
    },
  );

  it("preserves track and thumb overrides ahead of the tint fallback", () => {
    const trackColor = { false: "grey", true: "blue" };
    renderToStaticMarkup(
      <AndroidSwitch {...props} tintColor="red" trackColor={trackColor} thumbColor="white" />,
    );
    expect(androidSwitch.mock.lastCall?.[0]).toMatchObject({ trackColor, thumbColor: "white" });
    renderToStaticMarkup(<AndroidSwitch {...props} tintColor="red" />);
    expect(androidSwitch.mock.lastCall?.[0].trackColor).toEqual({ true: "red" });
  });
});
