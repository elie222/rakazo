// @vitest-environment jsdom
import type { ThreadMessage } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import PeerChat from "../app/peer-chat";
import { PeerReceiptLine } from "../components/peer-receipt-line";
import { peerExchangeLabel, resetI18nForTests } from "./i18n";

const { rpc, back, header } = vi.hoisted(() => ({ rpc: vi.fn(), back: vi.fn(), header: vi.fn() }));
vi.mock("./api", () => ({ rpc }));
vi.mock("expo-router", () => ({
  useLocalSearchParams: () => ({
    botId: "current",
    botName: "Editor",
    peerBotId: "peer",
    peerBotName: "Writer",
  }),
  useRouter: () => ({ back }),
  Stack: {
    Screen: ({ options }: { options: { headerTitle: () => ReactNode } }) => {
      header(options);
      return options.headerTitle();
    },
  },
}));
vi.mock("react-native", () => {
  const View = ({ children, testID }: { children?: ReactNode; testID?: string }) => (
    <div data-testid={testID}>{children}</div>
  );
  return {
    View,
    ScrollView: View,
    Platform: { OS: "ios" },
    Alert: { alert: vi.fn() },
    Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
    Pressable: ({
      children,
      onPress,
      onLongPress,
      accessibilityLabel,
      testID,
    }: {
      children?: ReactNode;
      onPress?: () => void;
      onLongPress?: () => void;
      accessibilityLabel?: string;
      testID?: string;
    }) => (
      <button
        type="button"
        data-testid={testID}
        aria-label={accessibilityLabel}
        onClick={onPress}
        onContextMenu={onLongPress}
      >
        {children}
      </button>
    ),
  };
});
vi.mock("expo-router/react-navigation", () => ({ useHeaderHeight: () => 64 }));
vi.mock("./artifact-open", () => ({ openMobileArtifact: vi.fn() }));
vi.mock("../components/inline-image-attachment", () => ({ InlineImageAttachment: () => null }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 20 }) }));
vi.mock("./appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("./native", () => ({ useMobileTokens: () => ({}), useResolvedAppearance: () => "light" }));
vi.mock("../components/bot-avatar", () => ({
  BotAvatar: ({ identity }: { identity: string }) => <i data-avatar={identity} />,
}));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button type="button" onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("@rakazo/chat-ui/native", () => ({
  ChatMarkdown: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
}));

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  rpc.mockReset();
  back.mockReset();
  header.mockReset();
  resetI18nForTests();
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});
const wake: ThreadMessage = {
  id: "wake",
  threadId: "t",
  seq: 1,
  role: "bot",
  runId: "run",
  createdAt: "2026-10-20T10:00:00Z",
  blocks: [
    {
      kind: "bot_message_received",
      fromBotId: "peer",
      fromBotName: "Writer",
      text: "Draft the fixture launch note.",
    },
  ],
};
const reply: ThreadMessage = {
  ...wake,
  id: "reply",
  seq: 2,
  blocks: [{ kind: "text", text: "Here is the draft." }],
};

it("loads all pages, renders both speakers and closes", async () => {
  rpc
    .mockResolvedValueOnce({ messages: [reply], olderCursor: 1 })
    .mockResolvedValueOnce({ messages: [wake], olderCursor: null });
  await act(async () => root.render(<PeerChat />));
  expect(rpc).toHaveBeenNthCalledWith(
    2,
    "threads/messages",
    { botId: "current", before: 1, includePeerRuns: true },
    { signal: expect.any(AbortSignal) },
  );
  expect(container.textContent).toContain("Draft the fixture launch note.");
  expect(container.textContent).toContain("Here is the draft.");
  expect(container.querySelector('[data-avatar="current"]')).not.toBeNull();
  expect(container.querySelector('[data-avatar="peer"]')).not.toBeNull();
  expect(header.mock.lastCall?.[0]).toMatchObject({
    headerTransparent: true,
    headerStyle: { backgroundColor: "transparent" },
  });
  expect(container.querySelector("textarea,input")).toBeNull();
  const close = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Close Chat",
  )!;
  act(() => close.click());
  expect(back).toHaveBeenCalledOnce();
});

it("retries a failed history request and shows the empty state", async () => {
  rpc
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce({ messages: [], olderCursor: null });
  await act(async () => root.render(<PeerChat />));
  expect(container.textContent).toContain("Could not load this chat.");
  await act(async () =>
    [...container.querySelectorAll("button")].find((b) => b.textContent === "Retry now")!.click(),
  );
  expect(container.textContent).toContain("No messages with Writer yet.");
});

it("shows loading while history is pending", async () => {
  rpc.mockReturnValue(new Promise(() => undefined));
  await act(async () => root.render(<PeerChat />));
  expect(container.textContent).toContain("Loading…");
});

it("opens a counted receipt and preserves long-press actions", () => {
  const open = vi.fn();
  const longPress = vi.fn();
  act(() =>
    root.render(
      <PeerReceiptLine
        peerBotId="peer"
        peerBotName="Writer"
        color="muted"
        count={3}
        direction="received"
        onPress={open}
        actionProps={{ onLongPress: longPress }}
      />,
    ),
  );
  const line = container.querySelector("button")!;
  expect(line.getAttribute("aria-label")).toBe("3 messages with Writer");
  expect(line.textContent).toBe("3 messages with Writer");
  act(() => line.click());
  expect(open).toHaveBeenCalledOnce();
  act(() => line.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })));
  expect(longPress).toHaveBeenCalledOnce();
});

it("uses Russian plural categories for counted exchanges", () => {
  resetI18nForTests("ru");
  expect(peerExchangeLabel(2, "received", "Writer")).toBe("2 сообщения с Writer");
  expect(peerExchangeLabel(5, "received", "Writer")).toBe("5 сообщений с Writer");
  expect(peerExchangeLabel(21, "received", "Writer")).toBe("21 сообщение с Writer");
});
