// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => {
  function MockView(props: {
    children?: ReactNode;
    accessible?: boolean;
    accessibilityElementsHidden?: boolean;
    importantForAccessibility?: string;
  }) {
    return createElement(
      "div",
      {
        "data-accessible": String(props.accessible),
        "aria-hidden": props.accessibilityElementsHidden ? "true" : undefined,
        "data-important": props.importantForAccessibility,
      },
      props.children,
    );
  }

  function MockImage(props: { style?: { tintColor?: string } }) {
    return createElement("img", { "data-tint": props.style?.tintColor });
  }

  return {
    Image: MockImage,
    StyleSheet: { create: <T,>(styles: T) => styles },
    View: MockView,
  };
});

vi.mock("./native", () => ({
  native: { label: "label" },
  useThemedStyles: <T,>(factory: () => T) => factory(),
}));

import { AppMark } from "../components/app-mark";

describe("AppMark", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container?.remove();
  });

  it("is hidden from VoiceOver and TalkBack and tinted like text", () => {
    act(() => {
      root?.render(<AppMark />);
    });
    const mark = container?.querySelector("div");

    expect(mark?.getAttribute("aria-hidden")).toBe("true");
    expect(mark?.dataset.accessible).toBe("false");
    expect(mark?.dataset.important).toBe("no-hide-descendants");
    expect(container?.querySelector("img")?.dataset.tint).toBe("label");
  });
});
