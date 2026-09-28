// @vitest-environment jsdom

import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const linking = vi.hoisted(() => ({
  canOpenURL: vi.fn(async () => true),
  openURL: vi.fn(async () => undefined),
}));

// react-native ships uncompiled Flow source that node cannot load, so tests mock
// its component surface as marker elements that expose the layout props the
// render rules set (horizontal scrolling, per-row minimum width).
vi.mock("react-native", async () => {
  const { createElement } = await import("react");

  const flattenStyle = (style: unknown): Record<string, unknown> =>
    Array.isArray(style)
      ? Object.assign({}, ...style.map(flattenStyle))
      : ((style ?? {}) as Record<string, unknown>);

  const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

  const mockComponent = (tag: string, dataKeys: string[] = []) =>
    function MockNativeComponent(props: Record<string, unknown>) {
      const {
        children,
        style,
        onPress,
        onLongPress: _onLongPress,
        onAccessibilityAction: _onAccessibilityAction,
        ...rest
      } = props;
      const flattened = flattenStyle(style);
      const data: Record<string, unknown> = {};
      for (const key of dataKeys) {
        const value = rest[key] ?? flattened[key];
        if (value !== undefined && value !== null && value !== false) {
          data[`data-${kebab(key)}`] = value === true ? "true" : value;
        }
      }
      return createElement(
        tag,
        {
          ...rest,
          ...data,
          onClick: typeof onPress === "function" ? () => void (onPress as () => void)() : undefined,
        },
        children as ReactNode,
      );
    };

  return {
    View: mockComponent("rn-view", ["minWidth"]),
    Text: mockComponent("rn-text", ["accessibilityRole"]),
    ScrollView: mockComponent("rn-scroll-view", ["horizontal"]),
    Pressable: mockComponent("rn-pressable", ["accessibilityRole"]),
    TextInput: mockComponent("rn-text-input"),
    Image: mockComponent("rn-image"),
    Animated: {
      View: mockComponent("rn-animated-view"),
      createAnimatedComponent: (component: unknown) => component,
      timing: () => ({ start: () => undefined }),
      sequence: (...animations: unknown[]) => animations,
      loop: (animation: unknown) => animation,
      delay: () => ({}),
      Value: class {},
    },
    StyleSheet: {
      create: (styles: unknown) => styles,
      flatten: flattenStyle,
      hairlineWidth: 1,
      absoluteFillObject: {},
      absoluteFill: {},
    },
    Platform: {
      OS: "ios",
      select: (options: Record<string, unknown>) =>
        options.ios ?? options.default ?? options.android,
    },
    Linking: linking,
  };
});

import { darkTokens } from "@rakazo/ui-tokens";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Pressable } from "react-native";
import { ChatMarkdown, LinkifiedText } from "./markdown.native";

const THREE_COLUMN_TABLE = `| Name | Status | Detail |
| --- | --- | --- |
| Alice | done | [docs](https://docs.example.test) |
| Bob | queued | A longer note that wraps inside the cell |`;

const SIX_COLUMN_TABLE = `| A | B | C | D | E | F |
| --- | --- | --- | --- | --- | --- |
| 1 | 2 | 3 | 4 | 5 | 6 |`;

describe("native markdown tables", () => {
  it("wraps the table in a horizontal scroll view", () => {
    const html = renderToStaticMarkup(<ChatMarkdown>{THREE_COLUMN_TABLE}</ChatMarkdown>);
    expect(html).toContain("<rn-scroll-view");
    expect(html).toContain('data-horizontal="true"');
  });

  it("sizes each row from its cell count so wide tables scroll instead of collapsing", () => {
    // Rows get a minimum width of TABLE_MIN_COLUMN_WIDTH (96) per cell.
    const narrow = renderToStaticMarkup(<ChatMarkdown>{THREE_COLUMN_TABLE}</ChatMarkdown>);
    expect(narrow).toContain('data-min-width="288"');
    expect(narrow).not.toContain('data-min-width="576"');

    const wide = renderToStaticMarkup(<ChatMarkdown>{SIX_COLUMN_TABLE}</ChatMarkdown>);
    expect(wide).toContain('data-min-width="576"');
  });

  it("renders cell text and keeps inline links tappable inside cells", () => {
    const html = renderToStaticMarkup(<ChatMarkdown>{THREE_COLUMN_TABLE}</ChatMarkdown>);
    expect(html).toContain("Alice");
    expect(html).toContain("A longer note that wraps inside the cell");
    expect(html).toContain('data-accessibility-role="link"');
    expect(html).toContain("docs");
  });

  it("applies the same table layout while streaming", () => {
    const html = renderToStaticMarkup(<ChatMarkdown streaming>{SIX_COLUMN_TABLE}</ChatMarkdown>);
    expect(html).toContain("<rn-scroll-view");
    expect(html).toContain('data-min-width="576"');
  });
});

describe("user message links", () => {
  it("opens a link tapped inside a user message bubble's long-press pressables", async () => {
    // The mobile thread wraps a user bubble in two long-press Pressables: the
    // row, then the bubble. A tap on the address still opens it, and markdown
    // markers stay literal characters.
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    linking.openURL.mockClear();
    linking.canOpenURL.mockClear();
    const longPress = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <Pressable accessible={false} onLongPress={longPress}>
          <Pressable onLongPress={longPress}>
            <LinkifiedText color={darkTokens.foreground} linkColor={darkTokens.link}>
              {"# Title **important** https://example.com/docs"}
            </LinkifiedText>
          </Pressable>
        </Pressable>,
      );
    });

    const link = container.querySelector<HTMLElement>(
      "rn-pressable rn-pressable [data-accessibility-role='link']",
    );
    expect(link?.textContent).toBe("https://example.com/docs");
    expect(container.textContent).toContain("# Title");
    expect(container.textContent).toContain("**important**");

    await act(async () => {
      link?.click();
    });
    await vi.waitFor(() => {
      expect(linking.openURL).toHaveBeenCalledWith("https://example.com/docs");
    });
    expect(longPress).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
