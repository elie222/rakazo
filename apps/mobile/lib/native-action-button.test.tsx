// @vitest-environment jsdom

import { tokensForAppearance } from "@rakazo/ui-tokens";
import type { CSSProperties, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NativeActionButton as FallbackButton } from "../components/native-action-button";
import { NativeActionButton as IosButton } from "../components/native-action-button.ios";

const platform = vi.hoisted(() => ({ OS: "ios", Version: 26 }));
const swiftButton = vi.hoisted(() => vi.fn());
const swiftLabel = vi.hoisted(() => vi.fn());
const appearance = vi.hoisted(() => ({ value: "light" as "light" | "dark" }));
const swiftHost = vi.hoisted(() => vi.fn());

vi.mock("react-native", () => ({
  Platform: platform,
  ActivityIndicator: () => null,
  Pressable: ({
    children,
    style,
    accessibilityState,
    accessibilityLabel,
  }: {
    children: ReactNode;
    accessibilityState?: { selected?: boolean; disabled?: boolean };
    accessibilityLabel?: string;
    style: (state: { pressed: boolean }) => CSSProperties[];
  }) => (
    <button
      type="button"
      aria-label={accessibilityLabel}
      aria-pressed={accessibilityState?.selected}
      disabled={accessibilityState?.disabled}
      style={Object.assign({}, ...style({ pressed: false }))}
    >
      {children}
    </button>
  ),
  Text: ({ children, style }: { children: ReactNode; style: CSSProperties }) => (
    <span style={style}>{children}</span>
  ),
}));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => <i /> }));
vi.mock("./native", () => ({
  useMobileTokens: () => tokensForAppearance(appearance.value),
  useResolvedAppearance: () => appearance.value,
  native: { label: tokensForAppearance("light").foreground },
}));
vi.mock("@expo/ui/swift-ui", () => ({
  Host: (props: { children: ReactNode }) => {
    swiftHost(props);
    return <div>{props.children}</div>;
  },
  Button: (props: { children?: ReactNode }) => {
    swiftButton(props);
    return props.children;
  },
  Label: (props: unknown) => {
    swiftLabel(props);
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
      "accessibilityAddTraits",
      "accessibilityRemoveTraits",
      "labelStyle",
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

beforeEach(() => {
  appearance.value = "light";
  swiftButton.mockClear();
  swiftLabel.mockClear();
  swiftHost.mockClear();
});

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

describe("compact native actions", () => {
  it.each([18, 26])("uses a small system icon and selected style on iOS %s", (version) => {
    platform.Version = version;
    renderToStaticMarkup(
      <IosButton
        accessibilityLabel="Keyboard"
        icon={{ ios: "keyboard", android: "keypad-outline" }}
        size="compact"
        prominence="secondary"
        fill
        selected
        onPress={() => {}}
      />,
    );
    expect(swiftButton.mock.lastCall?.[0]).toMatchObject({
      systemImage: "keyboard",
      modifiers: expect.arrayContaining([
        { name: "controlSize", value: "small" },
        { name: "labelStyle", value: "iconOnly" },
        { name: "buttonStyle", value: version >= 26 ? "glassProminent" : "borderedProminent" },
        { name: "accessibilityAddTraits", value: ["isSelected"] },
        { name: "accessibilityLabel", value: "Keyboard" },
      ]),
    });
    expect(swiftLabel.mock.lastCall?.[0]).toMatchObject({
      title: "Keyboard",
      systemImage: "keyboard",
      modifiers: [
        { name: "frame", value: { maxWidth: Infinity, minHeight: 16 } },
        { name: "foregroundStyle", value: tokensForAppearance("light").primaryForeground },
      ],
    });
    expect(swiftHost.mock.lastCall?.[0].style[0].minHeight).toBeUndefined();
    renderToStaticMarkup(
      <IosButton
        accessibilityLabel="Keyboard"
        icon={{ ios: "keyboard", android: "keypad-outline" }}
        size="compact"
        fill={false}
        onPress={() => {}}
      />,
    );
    expect(swiftButton.mock.lastCall?.[0]).toMatchObject({
      label: "Keyboard",
      systemImage: "keyboard",
    });
    renderToStaticMarkup(
      <IosButton label="Ctrl" size="compact" fill selected={false} onPress={() => {}} />,
    );
    expect(swiftButton.mock.lastCall?.[0].modifiers).toEqual(
      expect.arrayContaining([
        { name: "buttonStyle", value: version >= 26 ? "glass" : "bordered" },
        { name: "accessibilityRemoveTraits", value: ["isSelected"] },
      ]),
    );
  });
  it.each(["light", "dark"] as const)(
    "uses the filled foreground for enabled selected icons in %s mode",
    (scheme) => {
      appearance.value = scheme;
      for (const disabled of [false, true]) {
        renderToStaticMarkup(
          <IosButton
            accessibilityLabel="Keyboard"
            icon={{ ios: "keyboard", android: "keypad-outline" }}
            size="compact"
            prominence="secondary"
            fill
            selected
            disabled={disabled}
            onPress={() => {}}
          />,
        );
        const { modifiers } = swiftLabel.mock.lastCall![0];
        expect(
          modifiers.some((modifier: { name: string }) => modifier.name === "foregroundStyle"),
        ).toBe(!disabled);
        if (!disabled) {
          expect(modifiers).toContainEqual({
            name: "foregroundStyle",
            value: tokensForAppearance(scheme).primaryForeground,
          });
        }
      }
    },
  );
  it("shows a selected fallback without a minimum height", () => {
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(
      <FallbackButton label="Ctrl" size="compact" selected onPress={() => {}} />,
    );
    const button = host.querySelector("button")!;
    expect(button.style.minHeight).toBe("");
    expect(button.getAttribute("aria-pressed")).toBe("true");
    const expected = document.createElement("div");
    expected.style.backgroundColor = tokensForAppearance("light").primary;
    expect(button.style.backgroundColor).toBe(expected.style.backgroundColor);
    host.innerHTML = renderToStaticMarkup(
      <FallbackButton
        accessibilityLabel="Keyboard"
        icon={{ ios: "keyboard", android: "keypad-outline" }}
        size="compact"
        prominence="secondary"
        fill={false}
        selected={false}
        onPress={() => {}}
      />,
    );
    expect(host.querySelector("button")?.getAttribute("aria-pressed")).toBe("false");
    expect(host.querySelector("button")?.getAttribute("aria-label")).toBe("Keyboard");
    expect(host.querySelector("button")?.style.backgroundColor).toBe("transparent");
    expect(host.querySelector("i")).not.toBeNull();
  });
});
