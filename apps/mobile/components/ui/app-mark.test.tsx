// @vitest-environment jsdom

import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => {
  function MockImage(props: {
    accessible?: boolean;
    accessibilityElementsHidden?: boolean;
    importantForAccessibility?: string;
  }) {
    return createElement("img", {
      "data-accessible": String(props.accessible),
      "aria-hidden": props.accessibilityElementsHidden ? "true" : undefined,
      "data-important": props.importantForAccessibility,
    });
  }

  return {
    Image: MockImage,
    StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
  };
});

vi.mock("../../lib/native/native", () => ({
  native: { separator: "separator" },
  useThemedStyles: <T,>(factory: () => T) => factory(),
}));

import { AppMark } from "./app-mark";

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

  it("is hidden from VoiceOver and TalkBack", () => {
    act(() => {
      root?.render(<AppMark />);
    });
    const mark = container?.querySelector("img");

    expect(mark?.getAttribute("aria-hidden")).toBe("true");
    expect(mark?.dataset.accessible).toBe("false");
    expect(mark?.dataset.important).toBe("no-hide-descendants");
  });
});
