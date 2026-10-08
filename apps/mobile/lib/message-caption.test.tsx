// @vitest-environment jsdom

import { lightTokens } from "@rakazo/ui-tokens";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageCaption } from "../components/message-caption";

const linking = vi.hoisted(() => ({
  canOpenURL: vi.fn(async () => true),
  openURL: vi.fn(async () => undefined),
}));

vi.mock("react-native", () => {
  function View({ children }: { children?: ReactNode }) {
    return createElement("div", null, children);
  }
  function Text(props: {
    children?: ReactNode;
    style?: unknown;
    accessibilityRole?: string;
    onPress?: () => void;
  }) {
    const style = Array.isArray(props.style) ? Object.assign({}, ...props.style) : props.style;
    return createElement(
      "span",
      { style, role: props.accessibilityRole, onClick: props.onPress },
      props.children,
    );
  }
  return {
    View,
    Text,
    ScrollView: View,
    Pressable: View,
    TextInput: Text,
    Image: () => createElement("img"),
    Animated: { View, createAnimatedComponent: (component: unknown) => component },
    StyleSheet: {
      create: <T,>(styles: T) => styles,
      flatten: (styles: unknown) => (Array.isArray(styles) ? Object.assign({}, ...styles) : styles),
      hairlineWidth: 1,
    },
    Platform: { OS: "ios", select: (options: { ios?: unknown }) => options.ios },
    Linking: linking,
    Alert: {
      alert: (
        _title: string,
        _message: string,
        buttons: Array<{ text: string; onPress?: () => void }>,
      ) => buttons.find((button) => button.text === "Open")?.onPress?.(),
    },
    I18nManager: { isRTL: false },
  };
});

describe("attachment captions", () => {
  let root: Root;
  let container: HTMLDivElement;
  const caption = "**important** https://example.test/docs";

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  function render(role: "bot" | "user", streaming = false) {
    act(() => {
      root.render(
        <MessageCaption
          role={role}
          text={caption}
          tokens={lightTokens}
          colorScheme="light"
          streaming={streaming}
        />,
      );
    });
  }

  it("formats bot Markdown through ChatMarkdown", () => {
    render("bot");

    // A bare address shows as host and path, joined to its site icon and isolated.
    expect(container.textContent).toBe("important \u2060\u2068example.test/docs\u2069");
    expect(container.querySelector('[style*="font-weight: 700"]')?.textContent).toBe("important");
    expect(container.textContent).not.toContain("**");
  });

  it("keeps user Markdown literal through LinkifiedText and links explicit URLs", async () => {
    render("user");

    expect(container.textContent).toBe("**important** \u2060\u2068example.test/docs\u2069");
    expect(container.querySelector('[style*="font-weight: 700"]')).toBeNull();
    const link = container.querySelector<HTMLElement>('[role="link"]');
    expect(link?.textContent).toBe("\u2060\u2068example.test/docs\u2069");

    await act(async () => link?.click());

    expect(linking.openURL).toHaveBeenCalledWith("https://example.test/docs");
  });
});
