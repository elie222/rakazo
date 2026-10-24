// @vitest-environment jsdom

import { tokensForAppearance } from "@rakazo/ui-tokens";
import type { CSSProperties, ReactNode } from "react";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NativeActionButton as FallbackButton } from "../components/native-action-button";
import { NativeActionButton as IosButton } from "../components/native-action-button.ios";

const platform = vi.hoisted(() => ({ OS: "ios", Version: 26 }));
const pressable = vi.hoisted(() => vi.fn());
const swiftButton = vi.hoisted(() => vi.fn());
const swiftLabel = vi.hoisted(() => vi.fn());
const appearance = vi.hoisted(() => ({ value: "light" as "light" | "dark" }));
const swiftHost = vi.hoisted(() => vi.fn());
const swiftText = vi.hoisted(() => vi.fn());

vi.mock("react-native", () => ({
  useWindowDimensions: () => ({ fontScale: 1 }),
  StyleSheet: { flatten: (style: unknown) => style },
  Platform: platform,
  ActivityIndicator: () => null,
  Pressable: ({
    children,
    style,
    accessibilityState,
    accessibilityLabel,
    android_ripple,
  }: {
    children: ReactNode;
    android_ripple?: { color: string; foreground: boolean };
    accessibilityState?: { selected?: boolean; disabled?: boolean };
    accessibilityLabel?: string;
    style: (state: { pressed: boolean }) => CSSProperties[];
  }) => {
    pressable({ android_ripple });
    return (
      <button
        type="button"
        aria-label={accessibilityLabel}
        aria-pressed={accessibilityState?.selected}
        disabled={accessibilityState?.disabled}
        style={Object.assign({}, ...style({ pressed: false }))}
      >
        {children}
      </button>
    );
  },
  Text: ({ children, style }: { children: ReactNode; style: CSSProperties }) => (
    <span style={style}>{children}</span>
  ),
}));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => <i /> }));
vi.mock("./native", () => ({
  useMobileTokens: () => tokensForAppearance(appearance.value),
  useResolvedAppearance: () => appearance.value,
  native: {
    get label() {
      return tokensForAppearance(appearance.value).foreground;
    },
  },
}));
vi.mock("@expo/ui/swift-ui", () => ({
  Host: (props: { children: ReactNode; matchContents?: unknown }) => {
    // Like the native host, these measurement axes are fixed for a mounted instance.
    const [mountedMatchContents] = useState(() => props.matchContents);
    swiftHost({ ...props, mountedMatchContents });
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
  Text: (props: unknown) => {
    swiftText(props);
    return null;
  },
}));
vi.mock("@expo/ui/swift-ui/modifiers", () => {
  const modifier = (name: string) => (value: unknown) => ({ name, value });
  return {
    ...Object.fromEntries(
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
        "padding",
        "progressViewStyle",
        "tint",
        "background",
        "fixedSize",
        "strokeBorder",
      ].map((name) => [name, modifier(name)]),
    ),
    shapes: { roundedRectangle: modifier("roundedRectangle") },
  };
});

beforeEach(() => {
  platform.OS = "ios";
  appearance.value = "light";
  swiftButton.mockClear();
  swiftLabel.mockClear();
  swiftHost.mockClear();
  swiftText.mockClear();
});

describe("iOS action styling", () => {
  it("updates native measurement axes when recovery buttons stack and return to a row", () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const root = createRoot(document.createElement("div"));
    try {
      for (const fill of [false, true, false]) {
        act(() =>
          root.render(
            <IosButton
              label="Set your own key"
              variant="rectangular"
              fill={fill}
              style={fill ? { width: 280 } : undefined}
              onPress={() => {}}
            />,
          ),
        );
        expect(swiftHost.mock.lastCall?.[0].mountedMatchContents).toEqual(
          fill ? { vertical: true } : true,
        );
      }
    } finally {
      act(() => root.unmount());
      vi.unstubAllGlobals();
    }
  });

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

  it.each(["light", "dark"] as const)(
    "draws the filled foreground on compact primary actions in %s mode",
    (scheme) => {
      // In dark mode the system's white label sat on the light primary at about 1.1:1.
      appearance.value = scheme;
      renderToStaticMarkup(
        <IosButton label="Done" prominence="primary" fill={false} onPress={() => {}} />,
      );
      expect(swiftButton.mock.lastCall?.[0].label).toBeUndefined();
      expect(swiftText.mock.lastCall?.[0]).toEqual({
        children: "Done",
        modifiers: [
          { name: "foregroundStyle", value: tokensForAppearance(scheme).primaryForeground },
        ],
      });

      swiftText.mockClear();
      renderToStaticMarkup(
        <IosButton label="Done" prominence="primary" fill={false} disabled onPress={() => {}} />,
      );
      expect(swiftButton.mock.lastCall?.[0].label).toBe("Done");
      expect(swiftText).not.toHaveBeenCalled();
    },
  );

  it.each([true, false])(
    "fills destructive actions with the solid red in dark mode (fill %s)",
    (fill) => {
      // The text red is pale in dark mode, so the white label lost contrast on it.
      appearance.value = "dark";
      renderToStaticMarkup(
        <IosButton label="Delete group" prominence="destructive" fill={fill} onPress={() => {}} />,
      );
      const { modifiers, role } = swiftButton.mock.lastCall![0];
      expect(role).toBe("destructive");
      expect(modifiers).toContainEqual({
        name: "tint",
        value: tokensForAppearance("dark").destructiveFill,
      });
      expect(modifiers).not.toContainEqual({
        name: "tint",
        value: tokensForAppearance("dark").destructive,
      });
    },
  );

  it("keeps the system label on compact secondary actions", () => {
    appearance.value = "dark";
    renderToStaticMarkup(
      <IosButton label="Take control" prominence="secondary" fill={false} onPress={() => {}} />,
    );
    expect(swiftButton.mock.lastCall?.[0].label).toBe("Take control");
    expect(swiftText).not.toHaveBeenCalled();
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
      label: undefined,
      systemImage: "keyboard",
    });
    expect(swiftLabel.mock.lastCall?.[0]).toMatchObject({
      title: "Keyboard",
      systemImage: "keyboard",
      modifiers: [
        { name: "foregroundStyle", value: tokensForAppearance("light").primaryForeground },
      ],
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

describe("Android action feedback", () => {
  it.each(["light", "dark"] as const)(
    "clips custom corners and uses label alpha in %s mode",
    (scheme) => {
      platform.OS = "android";
      appearance.value = scheme;
      for (const prominence of ["primary", "quiet", "plain"] as const) {
        const host = document.createElement("div");
        host.innerHTML = renderToStaticMarkup(
          <FallbackButton
            label="Create"
            prominence={prominence}
            style={{ borderRadius: 24, overflow: "visible" }}
            onPress={() => {}}
          />,
        );
        expect(host.querySelector("button")!.style.borderRadius).toBe("24px");
        expect(host.querySelector("button")!.style.overflow).toBe("hidden");
        const label = host.querySelector("span")!;
        const channels = label.style.color.match(/\d+/g)!.slice(0, 3).join(", ");
        expect(pressable.mock.lastCall?.[0].android_ripple).toEqual({
          color: `rgba(${channels}, 0.2)`,
          foreground: true,
        });
      }
    },
  );
});

describe("destructive text actions", () => {
  it.each(["light", "dark"] as const)("uses red text and a 44pt target in %s mode", (scheme) => {
    appearance.value = scheme;
    renderToStaticMarkup(
      <IosButton
        label="Disconnect"
        prominence="destructive"
        variant="text"
        fill={false}
        onPress={() => {}}
      />,
    );
    expect(swiftButton.mock.lastCall?.[0]).toMatchObject({
      role: "destructive",
      modifiers: expect.arrayContaining([
        { name: "buttonStyle", value: "plain" },
        { name: "accessibilityLabel", value: "Disconnect" },
      ]),
    });
    expect(swiftText.mock.lastCall?.[0].modifiers).toEqual(
      expect.arrayContaining([
        { name: "foregroundStyle", value: tokensForAppearance(scheme).destructive },
        { name: "frame", value: { minHeight: 44 } },
      ]),
    );
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(
      <FallbackButton
        label="Disconnect"
        prominence="destructive"
        variant="text"
        fill={false}
        onPress={() => {}}
      />,
    );
    const button = host.querySelector("button")!;
    expect(button.getAttribute("aria-label")).toBe("Disconnect");
    expect(button.style.minHeight).toBe("44px");
    expect(button.style.backgroundColor).toBe("transparent");
    expect(button.style.borderWidth).toBe("0px");
    const expected = document.createElement("span");
    expected.style.color = tokensForAppearance(scheme).destructive;
    expect(host.querySelector("span")!.style.color).toBe(expected.style.color);
  });
});
