import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

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
      const { children, style, ...rest } = props;
      const flattened = flattenStyle(style);
      const data: Record<string, unknown> = {};
      for (const key of dataKeys) {
        const value = rest[key] ?? flattened[key];
        if (value !== undefined && value !== null && value !== false) {
          data[`data-${kebab(key)}`] = value === true ? "true" : value;
        }
      }
      return createElement(tag, { ...rest, ...data }, children as ReactNode);
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
    Linking: {
      canOpenURL: async () => true,
      openURL: async () => undefined,
    },
  };
});

import { ChatMarkdown } from "./markdown.native";

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
