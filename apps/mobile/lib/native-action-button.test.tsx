// @vitest-environment jsdom

import { tokensForAppearance } from "@rakazo/ui-tokens";
import type { CSSProperties, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NativeActionButton as FallbackButton } from "../components/native-action-button";
import { NativeActionButton as IosButton } from "../components/native-action-button.ios";

const platform = vi.hoisted(() => ({ OS: "ios", Version: 26 }));
const swiftButton = vi.hoisted(() => vi.fn());

vi.mock("react-native", () => ({
  Platform: platform,
  ActivityIndicator: () => null,
  Pressable: ({
    children,
    style,
  }: {
    children: ReactNode;
    style: (state: { pressed: boolean }) => CSSProperties[];
  }) => (
    <button type="button" style={Object.assign({}, ...style({ pressed: false }))}>
      {children}
    </button>
  ),
  Text: ({ children, style }: { children: ReactNode; style: CSSProperties }) => (
    <span style={style}>{children}</span>
  ),
}));
vi.mock("./native", () => ({
  useMobileTokens: () => tokensForAppearance("light"),
  useResolvedAppearance: () => "light",
  native: { label: tokensForAppearance("light").foreground },
}));
vi.mock("@expo/ui/swift-ui", () => ({
  Host: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Button: (props: unknown) => {
    swiftButton(props);
    return null;
  },
  ProgressView: () => null,
  Text: () => null,
}));
vi.mock("@expo/ui/swift-ui/modifiers", () => {
  const modifier = (name: string) => (value: unknown) => ({ name, value });
  return Object.fromEntries(
    [
      "accessibilityLabel",
      "buttonStyle",
      "controlSize",
      "disabled",
      "font",
      "foregroundStyle",
      "frame",
      "progressViewStyle",
      "tint",
    ].map((name) => [name, modifier(name)]),
  );
});

beforeEach(() => swiftButton.mockClear());

describe("iOS action styling", () => {
  it.each([18, 26])("keeps quiet actions small and muted on iOS %s", (version) => {
    platform.Version = version;
    renderToStaticMarkup(<IosButton label="Continue" prominence="quiet" onPress={() => {}} />);
    expect(swiftButton.mock.lastCall?.[0]).toMatchObject({
      label: "Continue",
      modifiers: expect.arrayContaining([
        { name: "buttonStyle", value: "plain" },
        { name: "controlSize", value: "small" },
        { name: "font", value: { size: 15 } },
        { name: "foregroundStyle", value: tokensForAppearance("light").mutedForeground },
      ]),
    });
  });

  it.each([18, 26])("preserves regular plain styling on iOS %s", (version) => {
    platform.Version = version;
    renderToStaticMarkup(<IosButton label="Continue" prominence="plain" onPress={() => {}} />);
    const { modifiers } = swiftButton.mock.lastCall![0];
    expect(modifiers).toEqual(
      expect.arrayContaining([
        { name: "buttonStyle", value: version >= 26 ? "glass" : "plain" },
        { name: "controlSize", value: "regular" },
      ]),
    );
    expect(modifiers).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "font" })]),
    );
    expect(modifiers).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "foregroundStyle" })]),
    );
  });

  it("honours explicit fill on quiet actions", () => {
    renderToStaticMarkup(<IosButton label="Continue" prominence="quiet" fill onPress={() => {}} />);
    expect(swiftButton.mock.lastCall?.[0].modifiers).toContainEqual({
      name: "controlSize",
      value: "large",
    });
  });
});

describe("fallback action styling", () => {
  it.each(["quiet", "plain"] as const)("renders a compact borderless %s action", (prominence) => {
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(
      <FallbackButton label="Continue" prominence={prominence} onPress={() => {}} />,
    );
    const button = host.querySelector("button")!;
    const label = host.querySelector("span")!;
    expect(button.style.backgroundColor).toBe("transparent");
    expect(button.style.borderWidth).toBe("0px");
    expect(button.style.minHeight).toBe("");
    expect(label.style.fontSize).toBe(prominence === "quiet" ? "15px" : "17px");
    expect(label.style.fontWeight).toBe("400");
    const expected = document.createElement("span");
    expected.style.color =
      prominence === "quiet"
        ? tokensForAppearance("light").mutedForeground
        : tokensForAppearance("light").foreground;
    expect(label.style.color).toBe(expected.style.color);
  });
});
