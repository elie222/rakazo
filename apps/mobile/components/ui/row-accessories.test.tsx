import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const nativeState = vi.hoisted(() => ({
  platform: { OS: "android" },
  direction: { isRTL: false },
}));

vi.mock("react-native", () => ({
  I18nManager: nativeState.direction,
}));

vi.mock("../../lib/native/native", () => ({
  native: { tertiaryLabel: "#333", label: "#111" },
  useMobileTokens: () => ({ foreground: "#111" }),
}));

vi.mock("expo-symbols", () => ({
  SymbolView: ({ name, fallback }: { name: string; fallback: ReactNode }) =>
    nativeState.platform.OS === "android" ? fallback : <span data-icon={name} />,
}));

vi.mock("@react-native-vector-icons/ionicons", () => ({
  default: ({ name }: { name: string }) => <span data-icon={name} />,
}));

vi.mock("@react-native-vector-icons/material-design-icons", () => ({
  MaterialDesignIcons: () => null,
}));

import { Chevron } from "./row-accessories";

describe("row disclosure chevron", () => {
  it.each([
    ["android", false, false, "chevron-forward"],
    ["android", true, false, "chevron-back"],
    ["android", false, true, "chevron-down"],
    ["android", true, true, "chevron-down"],
    ["ios", false, false, "chevron.right"],
    ["ios", true, false, "chevron.right"],
    ["ios", true, true, "chevron.down"],
  ] as const)(
    "uses the expected icon on %s (RTL: %s, expanded: %s)",
    (platform, rtl, expanded, icon) => {
      nativeState.platform.OS = platform;
      nativeState.direction.isRTL = rtl;

      expect(renderToStaticMarkup(<Chevron expanded={expanded} />)).toContain(
        `data-icon="${icon}"`,
      );
    },
  );
});
