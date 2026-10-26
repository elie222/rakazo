// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => {
  const flatten = (style: unknown): Record<string, unknown> =>
    Array.isArray(style)
      ? Object.assign({}, ...style.map(flatten))
      : ((style ?? {}) as Record<string, unknown>);
  return {
    StyleSheet: { create: <T,>(styles: T) => styles },
    View: (props: {
      children?: ReactNode;
      style?: unknown;
      accessible?: boolean;
      accessibilityLabel?: string;
    }) =>
      createElement(
        "div",
        {
          "aria-label": props.accessibilityLabel,
          "data-accessible": String(props.accessible),
          "data-style": JSON.stringify(flatten(props.style)),
        },
        props.children,
      ),
    Text: (props: { children?: ReactNode; style?: unknown }) =>
      createElement("span", { "data-style": JSON.stringify(flatten(props.style)) }, props.children),
  };
});
vi.mock("./native", () => ({ useMobileTokens: () => ({ primary: "ink", unread: "unread-blue" }) }));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));

import { UnreadDivider } from "../components/unread-divider";

describe("UnreadDivider", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  });

  it("avoids extra top spacing after a time separator", () => {
    act(() => root.render(<UnreadDivider afterSeparator />));
    const row = container.firstElementChild as HTMLElement;
    expect(JSON.parse(row.dataset.style!).paddingTop).toBe(0);
  });

  it("reads as one element, New messages, with an uppercase New between two unread-blue hairlines", () => {
    act(() => root.render(<UnreadDivider />));
    const row = container.firstElementChild as HTMLElement;
    expect(row.getAttribute("aria-label")).toBe("New messages");
    expect(row.dataset.accessible).toBe("true");
    const [before, label, after] = [...row.children] as HTMLElement[];
    expect(label?.textContent).toBe("New");
    expect(JSON.parse(label!.dataset.style!)).toMatchObject({
      color: "unread-blue",
      textTransform: "uppercase",
      fontWeight: "600",
      fontSize: 12,
      lineHeight: 16,
      letterSpacing: 0.5,
    });
    for (const line of [before, after]) {
      expect(JSON.parse(line!.dataset.style!)).toMatchObject({
        backgroundColor: "unread-blue",
        height: 1,
        flex: 1,
        opacity: 0.5,
      });
    }
  });
});
