// @vitest-environment jsdom

import type { ReactNode, Ref } from "react";
import { act, createElement, useImperativeHandle } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import PeerChat from "../app/peer-chat";

const { rpc, back, scrollToEnd, scrollProps } = vi.hoisted(() => ({
  rpc: vi.fn(),
  back: vi.fn(),
  scrollToEnd: vi.fn(),
  scrollProps: {
    current: {} as { onContentSizeChange?: () => void; onScrollBeginDrag?: () => void },
  },
}));

vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({ label, onPress }: { label: string; onPress: () => void }) =>
    createElement("button", { type: "button", onClick: onPress }, label),
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("../components/inline-image-attachment", () => ({ InlineImageAttachment: () => null }));
vi.mock("./artifact-open", () => ({ openMobileArtifact: vi.fn() }));
vi.mock("./api", () => ({ rpc }));
vi.mock("./side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("./appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("./native", () => ({
  native: {},
  useResolvedAppearance: () => "light",
  useThemedStyles: (createStyles: () => unknown) => createStyles(),
}));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));
vi.mock("../components/glass-title", () => ({ glassHeaderOptions: () => ({}) }));
vi.mock("@rakazo/chat-ui/native", () => ({
  ChatMarkdown: ({ children }: { children: ReactNode }) => createElement("p", null, children),
}));
vi.mock("expo-router", () => ({
  Stack: {
    Screen: ({ options }: { options: { headerTitle: () => ReactNode } }) => options.headerTitle(),
  },
  useRouter: () => ({ back }),
  useLocalSearchParams: () => ({ botId: "chief", botName: "Chief", peerBotId: "peer" }),
}));
vi.mock("react-native", () => {
  const view = ({ children }: { children?: ReactNode }) => createElement("div", null, children);
  return {
    StyleSheet: { create: (styles: unknown) => styles },
    ActivityIndicator: () => createElement("progress"),
    Pressable: view,
    Text: view,
    View: view,
    ScrollView: ({
      ref,
      children,
      ...props
    }: {
      ref?: Ref<unknown>;
      children?: ReactNode;
      onContentSizeChange?: () => void;
      onScrollBeginDrag?: () => void;
    }) => {
      useImperativeHandle(ref, () => ({ scrollToEnd }));
      scrollProps.current = props;
      return createElement("div", null, children);
    },
  };
});

let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = "";
  rpc.mockReset();
  back.mockReset();
  scrollToEnd.mockReset();
});

async function open() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  rpc.mockResolvedValue({
    messages: Array.from({ length: 40 }, (_, index) => ({
      id: `message-${index}`,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      blocks: [
        {
          kind: "bot_message_sent",
          toBotId: "peer",
          toBotName: "Researcher",
          text: `note ${index}`,
        },
      ],
    })),
    olderCursor: null,
  });
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(createElement(PeerChat)));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  return container;
}

it("opens the exchange at its latest message", async () => {
  const screen = await open();
  expect(screen.textContent).toContain("note 39");

  act(() => scrollProps.current.onContentSizeChange?.());

  expect(scrollToEnd).toHaveBeenCalledWith({ animated: false });
});

it("leaves the position alone once the reader scrolls", async () => {
  await open();

  act(() => {
    scrollProps.current.onScrollBeginDrag?.();
    scrollProps.current.onContentSizeChange?.();
  });

  expect(scrollToEnd).not.toHaveBeenCalled();
});

it("names both bots in the header and closes the read-only chat", async () => {
  const screen = await open();
  expect(screen.textContent).toContain("Chief⇄Researcher");
  const close = screen.querySelector<HTMLButtonElement>("button");
  expect(close?.textContent).toBe("Close Chat");
  act(() => close?.click());
  expect(back).toHaveBeenCalledOnce();
});
