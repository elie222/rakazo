// @vitest-environment jsdom

import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as NativeModule from "./native";

const contrast = vi.hoisted(() => ({
  changed: undefined as ((enabled: boolean) => void) | undefined,
  resolved: "dark" as "dark" | "light",
  resolveInitial: undefined as ((enabled: boolean) => void) | undefined,
}));

vi.mock("react-native", () => ({
  AccessibilityInfo: {
    addEventListener: (_event: string, handler: (enabled: boolean) => void) => {
      contrast.changed = handler;
      return { remove: () => undefined };
    },
    isDarkerSystemColorsEnabled: () =>
      new Promise<boolean>((resolve) => {
        contrast.resolveInitial = resolve;
      }),
  },
  Platform: { OS: "ios" },
  PlatformColor: (name: string) => `platform:${name}`,
}));

vi.mock("./appearance", () => ({
  getCachedAppearancePreference: () => "system",
  mobileTokens: () => ({ card: "token-card" }),
  resolveMobileAppearance: () => contrast.resolved,
  subscribeAppearance: () => () => undefined,
}));

let nativeModule: typeof NativeModule;

let seen: unknown;

function Probe() {
  seen = nativeModule.useThemedStyles(() => nativeModule.native.groupedCell);
  return null;
}

describe("grouped cells with Increase Contrast", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(async () => {
    // Each case gets a fresh contrast subscription and pending initial read.
    vi.resetModules();
    nativeModule = await import("./native");
    contrast.changed = undefined;
    contrast.resolveInitial = undefined;
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    contrast.resolved = "dark";
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container?.remove();
    vi.unstubAllGlobals();
  });

  it("switches dark cells to the card token while darker system colours are on", async () => {
    await act(async () => {
      root?.render(<Probe />);
    });
    await act(async () => contrast.resolveInitial?.(false));
    expect(seen).toBe("platform:secondarySystemGroupedBackground");

    act(() => contrast.changed?.(true));
    expect(seen).toBe("token-card");

    act(() => contrast.changed?.(false));
    expect(seen).toBe("platform:secondarySystemGroupedBackground");
  });

  it("applies Increase Contrast from the initial read", async () => {
    await act(async () => root?.render(<Probe />));
    await act(async () => contrast.resolveInitial?.(true));
    expect(seen).toBe("token-card");
  });

  it("ignores an initial read that resolves after a newer change event", async () => {
    await act(async () => root?.render(<Probe />));
    act(() => contrast.changed?.(true));
    await act(async () => contrast.resolveInitial?.(false));
    expect(seen).toBe("token-card");
  });

  it("keeps the system cell in light", async () => {
    contrast.resolved = "light";
    await act(async () => {
      root?.render(<Probe />);
    });

    act(() => contrast.changed?.(true));
    expect(seen).toBe("platform:secondarySystemGroupedBackground");
  });
});
