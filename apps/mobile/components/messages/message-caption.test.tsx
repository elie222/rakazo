// @vitest-environment jsdom

import { lightTokens } from "@rakazo/ui-tokens";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenPageContext, UserMentionsContext } from "../../lib/messages/message-mentions";
import { MessageCaption } from "./message-caption";

const linking = vi.hoisted(() => ({
  canOpenURL: vi.fn(async () => true),
  openURL: vi.fn(async () => undefined),
}));

// Mock the avatar and icon rendering, but retain the icon's color at the native boundary.
vi.mock("../bots/bot-avatar", () => ({ BotAvatar: () => null }));
vi.mock("../native/native-symbol", () => ({
  NativeSymbol: ({ ios, color }: { ios: string; color: string }) =>
    createElement("span", { "data-symbol": ios, "data-color": color }),
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
    useColorScheme: () => "light",
    useWindowDimensions: () => ({ fontScale: 1 }),
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

  it("hands bot Markdown to the native Markdown view", () => {
    render("bot");

    expect(container.querySelector("rn-enriched-markdown")?.textContent).toBe(
      "**important** https://example.test/docs",
    );
  });

  it("keeps user Markdown literal through LinkifiedText and links explicit URLs", async () => {
    render("user");

    expect(container.textContent).toBe("**important** \u2060\u2068example.test/docs\u2069");
    expect(container.querySelector('[style*="font-weight: 600"]')).toBeNull();
    const link = container.querySelector<HTMLElement>('[role="link"]');
    expect(link?.textContent).toBe("\u2060\u2068example.test/docs\u2069");

    await act(async () => link?.click());

    expect(linking.openURL).toHaveBeenCalledWith("https://example.test/docs");
  });

  it("uses the received caption foreground for the everyone icon", () => {
    const role = "user";
    act(() => {
      root.render(
        <UserMentionsContext.Provider
          value={{
            targets: [{ kind: "everyone", id: "everyone", name: "everyone" }],
            onOpenBot: vi.fn(),
          }}
        >
          <MessageCaption
            role={role}
            received
            text="@everyone Sample caption"
            tokens={lightTokens}
            colorScheme="light"
            streaming={false}
          />
        </UserMentionsContext.Provider>,
      );
    });

    const icon = container.querySelector('[data-symbol="person.3"]');
    expect(icon?.getAttribute("data-color")).toBe(lightTokens.foreground);
  });

  it("opens the page a sent page link names from the user's bubble", async () => {
    const openPage = vi.fn();
    const role = "user";
    act(() => {
      root.render(
        <OpenPageContext.Provider value={openPage}>
          <MessageCaption
            role={role}
            text={"[Plan](page:pg_1)\nnice"}
            tokens={lightTokens}
            colorScheme="light"
            streaming={false}
          />
        </OpenPageContext.Provider>,
      );
    });

    expect(container.textContent).not.toContain("page:pg_1");
    const chip = container.querySelector<HTMLElement>('[role="link"]');
    expect(chip?.textContent).toContain("Plan");

    await act(async () => chip?.click());

    expect(openPage).toHaveBeenCalledWith("pg_1");
  });
});
