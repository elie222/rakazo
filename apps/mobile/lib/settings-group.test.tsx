// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { Platform } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let fontScale = 1;

vi.mock("react-native", () => {
  function MockView(props: {
    children?: ReactNode;
    style?: unknown;
    accessible?: boolean;
    accessibilityLabel?: string;
    accessibilityElementsHidden?: boolean;
    accessibilityRole?: string;
    accessibilityValue?: { text?: string };
    accessibilityState?: { disabled?: boolean };
  }) {
    return createElement(
      "div",
      {
        role: props.accessible ? (props.accessibilityRole ?? "group") : undefined,
        "aria-label": props.accessibilityLabel,
        "aria-hidden": props.accessibilityElementsHidden ? "true" : undefined,
        "aria-valuetext": props.accessibilityValue?.text,
        "aria-disabled": props.accessibilityState?.disabled,
        "data-style": JSON.stringify(props.style ?? null),
      },
      props.children,
    );
  }

  function MockText(props: { children?: ReactNode; accessibilityRole?: string; style?: unknown }) {
    return createElement(
      "span",
      { role: props.accessibilityRole, "data-style": JSON.stringify(props.style ?? null) },
      props.children,
    );
  }

  function MockPressable(props: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    accessibilityRole?: string;
    accessibilityLabel?: string;
    accessibilityValue?: { text?: string };
    accessibilityState?: { expanded?: boolean };
    style?: unknown;
    android_ripple?: unknown;
  }) {
    const pressedStyle =
      typeof props.style === "function" ? props.style({ pressed: true }) : props.style;
    const style = typeof props.style === "function" ? props.style({ pressed: false }) : props.style;
    return createElement(
      "button",
      {
        type: "button",
        "data-style": JSON.stringify(style ?? null),
        "data-pressed-style": JSON.stringify(pressedStyle ?? null),
        "data-ripple": JSON.stringify(props.android_ripple ?? null),
        disabled: props.disabled,
        role: props.accessibilityRole,
        "aria-label": props.accessibilityLabel,
        "aria-valuetext": props.accessibilityValue?.text,
        "aria-expanded": props.accessibilityState?.expanded,
        onClick: () => {
          if (!props.disabled) props.onPress?.();
        },
      },
      props.children,
    );
  }

  function MockSwitch(props: {
    accessibilityLabel?: string;
    accessibilityHint?: string;
    disabled?: boolean;
    value: boolean;
    onValueChange: (value: boolean) => void;
  }) {
    return createElement("input", {
      type: "checkbox",
      "aria-label": props.accessibilityLabel,
      "aria-description": props.accessibilityHint,
      checked: props.value,
      disabled: props.disabled,
      onChange: () => props.onValueChange(!props.value),
    });
  }

  return {
    Platform: { OS: "ios" },
    Pressable: MockPressable,
    Switch: MockSwitch,
    StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 0.5 },
    Text: MockText,
    View: MockView,
    useWindowDimensions: () => ({ width: 393, height: 852, scale: 3, fontScale }),
  };
});

vi.mock("./native", () => ({
  native: {
    fill: "fill",
    groupedCell: "grouped-cell",
    fillPressed: "fill-pressed",
    label: "label",
    secondaryLabel: "secondary-label",
    tertiaryLabel: "tertiary-label",
    separator: "separator",
  },
  useThemedStyles: <T,>(factory: () => T) => factory(),
  useResolvedAppearance: () => "light",
  systemGreen: () => "system-green",
}));

vi.mock("./appearance", () => ({
  mobileTokens: () => ({ destructive: "destructive" }),
}));

vi.mock("../components/native-symbol", () => {
  return { NativeSymbol: () => createElement("i", null, "chevron") };
});

import { SettingsGroup, SettingsRow, SettingsSwitch } from "../components/settings-group";

function separators(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>("div[data-style]")].filter((element) =>
    [JSON.parse(element.dataset.style ?? "null")]
      .flat()
      .some((style) => style?.backgroundColor === "separator"),
  );
}

describe("settings group", () => {
  it("preserves the value and disabled state when a native menu owns the row action", () => {
    const view = render(
      <SettingsRow
        accessible
        accessibilityRole="button"
        accessibilityLabel="Thinking"
        accessibilityValue={{ text: "High" }}
        accessibilityState={{ disabled: true }}
        title="Thinking"
        value="High"
      />,
    );
    const row = view.querySelector('[aria-label="Thinking"]');
    expect(row?.getAttribute("role")).toBe("button");
    expect(row?.getAttribute("aria-valuetext")).toBe("High");
    expect(row?.getAttribute("aria-disabled")).toBe("true");
  });

  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(() => {
    fontScale = 1;
    Platform.OS = "ios";
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container?.remove();
    root = undefined;
    container = undefined;
    Platform.OS = "ios";
  });

  function render(node: ReactNode) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root?.render(node);
    });
    return container;
  }

  it("draws separators only between the rows that render", () => {
    const view = render(
      <SettingsGroup>
        <SettingsRow onPress={() => undefined} title="Models" />
        {null}
        <SettingsRow onPress={() => undefined} title="Voice" />
        {false}
        <SettingsRow onPress={() => undefined} title="Integrations" />
      </SettingsGroup>,
    );

    expect(view.querySelectorAll("button")).toHaveLength(3);
    expect(separators(view)).toHaveLength(2);
  });

  it("renders nothing when every row is hidden", () => {
    const view = render(<SettingsGroup label="Archived bots">{null}</SettingsGroup>);

    expect(view.innerHTML).toBe("");
  });

  it("sets the group label, row detail and footer at 14pt on an 18pt line", () => {
    const view = render(
      <SettingsGroup label="Appearance" footer="Applies on this device.">
        <SettingsRow title="Language" detail="Follows the system" />
      </SettingsGroup>,
    );
    const textStyle = (content: string) => {
      const span = [...view.querySelectorAll<HTMLElement>("span")].find(
        (element) => element.textContent === content,
      );
      return Object.assign({}, ...[JSON.parse(span?.dataset.style ?? "null")].flat());
    };

    for (const content of ["Appearance", "Follows the system", "Applies on this device."]) {
      expect(textStyle(content)).toMatchObject({ fontSize: 14, lineHeight: 18 });
    }
    expect(textStyle("Language")).toMatchObject({ fontSize: 17 });
  });

  it("announces the group label as a header", () => {
    const view = render(
      <SettingsGroup label="Appearance">
        <SettingsRow title="Language" />
      </SettingsGroup>,
    );

    expect(view.querySelector('[role="header"]')?.textContent).toBe("Appearance");
  });

  it("keeps the row's accessibility props and handler and hides the chevron", () => {
    const onPress = vi.fn();
    const view = render(
      <SettingsRow
        accessibilityRole="button"
        accessibilityLabel="Language"
        accessibilityValue={{ text: "English" }}
        chevron="right"
        onPress={onPress}
        title="Language"
        value="English"
      />,
    );
    const row = view.querySelector("button");

    expect(row?.getAttribute("role")).toBe("button");
    expect(row?.getAttribute("aria-label")).toBe("Language");
    expect(row?.getAttribute("aria-valuetext")).toBe("English");
    expect(view.querySelector('[aria-hidden="true"]')?.textContent).toBe("chevron");
    act(() => row?.click());
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("does not run a disabled row's handler", () => {
    const onPress = vi.fn();
    const view = render(<SettingsRow disabled onPress={onPress} title="Models" />);

    act(() => view.querySelector("button")?.click());
    expect(onPress).not.toHaveBeenCalled();
  });

  it.each(["android", "ios"] as const)("uses platform press feedback on %s", (platform) => {
    Platform.OS = platform;
    const view = render(<SettingsRow onPress={() => undefined} title="Models" />);
    const row = view.querySelector("button")!;
    const pressedStyle = Object.assign({}, ...JSON.parse(row.dataset.pressedStyle ?? "[]"));

    if (platform === "android") {
      expect(JSON.parse(row.dataset.ripple ?? "null")).toEqual({
        foreground: true,
        color: expect.any(String),
      });
      expect(pressedStyle.backgroundColor).not.toBe("fill-pressed");
    } else {
      expect(pressedStyle.backgroundColor).toBe("fill-pressed");
    }
  });

  it("keeps rows at least 44 pt tall", () => {
    const view = render(<SettingsRow onPress={() => undefined} title="Models" />);
    const styles: (Record<string, unknown> | null)[] = JSON.parse(
      view.querySelector("button")?.dataset.style ?? "[]",
    );
    const minHeight = Math.max(...styles.map((style) => Number(style?.minHeight) || 0));

    expect(minHeight).toBeGreaterThanOrEqual(44);
  });

  it("makes a read-only row one element when asked, without a button role", () => {
    const view = render(<SettingsRow accessible title="Alex Example" detail="alex@example.test" />);
    const row = view.querySelector('[role="group"]');

    expect(view.querySelector("button")).toBeNull();
    expect(row?.textContent).toBe("Alex Examplealex@example.test");
  });

  it("names a switch by its label and uses the detail as its hint", () => {
    const onChange = vi.fn();
    const view = render(
      <SettingsSwitch
        label="Agent messages"
        detail="Replies and completed work"
        value={false}
        onChange={onChange}
      />,
    );
    const toggle = view.querySelector("input");

    expect(toggle?.getAttribute("aria-label")).toBe("Agent messages");
    expect(toggle?.getAttribute("aria-description")).toBe("Replies and completed work");
    act(() => toggle?.click());
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("moves the value under the title at large text sizes", () => {
    const row = (
      <SettingsRow chevron="right" onPress={() => undefined} title="Language" value="English" />
    );
    const columnText = (view: HTMLElement) => view.querySelector("button > div")?.textContent ?? "";

    expect(columnText(render(row))).toBe("Language");
    act(() => root?.unmount());
    container?.remove();

    fontScale = 1.353;
    expect(columnText(render(row))).toBe("LanguageEnglish");
  });

  it("moves the switch under its label at large text sizes", () => {
    const row = <SettingsSwitch label="Stream replies" value={false} onChange={() => undefined} />;
    const beforeSwitch = (view: HTMLElement) =>
      view.querySelector("input")?.parentElement?.previousElementSibling?.tagName;

    expect(beforeSwitch(render(row))).toBe("DIV");
    act(() => root?.unmount());
    container?.remove();

    fontScale = 1.353;
    expect(beforeSwitch(render(row))).toBe("SPAN");
  });
});
