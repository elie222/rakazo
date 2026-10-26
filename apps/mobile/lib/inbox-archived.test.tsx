// @vitest-environment jsdom

import type { CSSProperties, ReactNode } from "react";
import { act, useEffect, useMemo } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import GroupSettingsScreen from "../app/group-settings";
import { createHomeStyles } from "../components/home-styles";
import { InboxListFooter } from "../components/inbox-render-item";
import { ArchivedChatsRow, CompactRowsContext } from "../components/inbox-rows";
import { useThreadHeader } from "../components/thread/thread-header";
import type { loadAllArchivedChats } from "./archived-chats";
import { notifyArchivedChatsChanged, onArchivedChatsChanged } from "./archived-chats";
import { useArchivedCount } from "./use-archived-count";

type AlertButton = { text: string; onPress?: () => void };
const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  alert: vi.fn(),
  removeFromSearchInbox: vi.fn(),
  loadArchived: vi.fn(),
  router: {
    push: vi.fn(),
    replace: vi.fn(),
    dismissAll: vi.fn(),
    setParams: vi.fn(),
  },
}));

vi.mock("react-native", () => {
  const flatten = (style: unknown): CSSProperties =>
    Object.assign({}, ...[style].flat(Number.POSITIVE_INFINITY).filter(Boolean));
  const View = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Alert: { alert: mocks.alert },
    Platform: { OS: "ios" },
    PlatformColor: (name: string) => name,
    StyleSheet: { create: <T,>(styles: T) => styles },
    useWindowDimensions: () => ({ width: 400, height: 800, fontScale: 1 }),
    Modal: View,
    ScrollView: View,
    TextInput: () => null,
    View,
    Text: ({ children, style }: { children?: ReactNode; style?: unknown }) => (
      <span style={flatten(style)}>{children}</span>
    ),
    Pressable: ({
      children,
      accessibilityRole,
      accessibilityLabel,
      onPress,
      style,
    }: {
      children?: ReactNode;
      accessibilityRole?: string;
      accessibilityLabel?: string;
      onPress?: () => void;
      style?: unknown;
    }) => {
      const merged = flatten(typeof style === "function" ? style({ pressed: false }) : style);
      return (
        <button
          type="button"
          data-role={accessibilityRole}
          aria-label={accessibilityLabel}
          // React Native's paddingHorizontal has no DOM equivalent, so expose it directly.
          data-padding-horizontal={(merged as { paddingHorizontal?: number }).paddingHorizontal}
          onClick={onPress}
          style={merged}
        >
          {children}
        </button>
      );
    },
  };
});
vi.mock("react-native-reanimated", () => ({ default: {} }));
vi.mock("@expo/ui/community/menu", () => ({ MenuView: () => null }));
vi.mock("expo-router", () => ({
  // The inbox stays focused here; expo-router reruns the effect when its callback changes.
  useFocusEffect: (effect: () => (() => void) | undefined) => useEffect(effect, [effect]),
  useRouter: () => mocks.router,
  useNavigation: () => ({ setOptions: vi.fn() }),
  useRoute: () => ({ key: "thread-1" }),
  useLocalSearchParams: () => ({ groupId: "group-b" }),
  Stack: { Screen: () => null },
}));
vi.mock("./api", () => ({ rpc: mocks.rpc }));
vi.mock("./native", () => ({
  native: { tertiaryLabel: "tertiary" },
  useThemedStyles: (factory: () => unknown) => useMemo(factory, [factory]),
  useResolvedAppearance: () => "light",
  useMobileTokens: () => ({}),
}));
vi.mock("./appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("./i18n", () => {
  const t = (text: string, values?: Record<string, string>) =>
    text.replace(/\{(\w+)\}/g, (_, key: string) => values?.[key] ?? key);
  return { t, useI18n: () => ({ t }), dateLocaleForUi: () => "en-US" };
});
vi.mock("./user-error", () => ({ errorText: () => "failure" }));
vi.mock("./search-inbox", () => ({ removeFromSearchInbox: mocks.removeFromSearchInbox }));
vi.mock("./side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("./thread-edges", () => ({ threadEdgeOptions: () => ({}) }));
vi.mock("./archived-chats", async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
  loadAllArchivedChats: mocks.loadArchived,
}));
vi.mock("./avatar-life", () => ({ AvatarRow: () => null }));
vi.mock("../components/bot-avatar", () => ({ BotAvatar: () => null }));
vi.mock("../components/group-avatar", () => ({ GroupAvatar: () => null }));
vi.mock("../components/inbox-swipe-row", () => ({ InboxSwipeRow: () => null }));
vi.mock("../components/native-symbol", () => ({
  NativeSymbol: ({ ios }: { ios: string }) => <i data-symbol={ios} />,
}));
vi.mock("../components/chat-header-title", () => ({ publishChatTitle: () => undefined }));
vi.mock("../components/sheet-header", () => ({ trailingHeaderOptions: () => ({}) }));
vi.mock("../components/thread-header-right", () => ({ threadHeaderRight: () => ({}) }));
vi.mock("../components/bot-member-picker", () => ({ BotMemberPicker: () => null }));
vi.mock("../components/glass-title", () => ({ glassHeaderOptions: () => ({}) }));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button type="button" onClick={onPress}>
      {label}
    </button>
  ),
}));

let container: HTMLDivElement;
let root: Root;
const flush = () => act(async () => undefined);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.rpc.mockReset();
  mocks.alert.mockReset();
  mocks.removeFromSearchInbox.mockReset();
  for (const route of Object.values(mocks.router)) route.mockReset();
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

/** Counts archive and restore signals, the way the inbox's archived count hears them. */
function listenForArchiveChanges() {
  const listener = vi.fn();
  const stop = onArchivedChatsChanged(listener);
  return { listener, stop };
}
const alertButton = (call: number, text: string) =>
  (mocks.alert.mock.calls[call]![2] as AlertButton[]).find((button) => button.text === text)!;

describe("archived chats row", () => {
  const styles = createHomeStyles();

  function render(count: number, compact = false) {
    const onPress = vi.fn();
    act(() =>
      root.render(
        <CompactRowsContext.Provider value={compact}>
          <ArchivedChatsRow count={count} onPress={onPress} />
        </CompactRowsContext.Provider>,
      ),
    );
    return onPress;
  }

  it("shows nothing until a chat is archived", () => {
    render(0);
    expect(container.innerHTML).toBe("");
  });

  it("names the archive with its count and a chevron, and opens it", () => {
    const onPress = render(3);
    const button = container.querySelector("button")!;
    expect(button.getAttribute("data-role")).toBe("button");
    expect(button.getAttribute("aria-label")).toBe("Archived, 3");
    expect(Array.from(button.querySelectorAll("span"), (span) => span.textContent)).toEqual([
      "Archived",
      "3",
    ]);
    expect(button.querySelectorAll("span")[1]!.style.fontSize).toBe(
      `${styles.sectionCount.fontSize}px`,
    );
    expect(button.querySelector("i")?.getAttribute("data-symbol")).toBe("chevron.right");
    act(() => button.click());
    expect(onPress).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "lines up with the section headers and fills a 44pt tap target (compact: %s)",
    (compact) => {
      render(3, compact);
      const button = container.querySelector("button")!;
      // The same inset as a section header, not the chat-name column past the avatar.
      expect(button.style.paddingInlineStart).toBe("");
      expect(button.getAttribute("data-padding-horizontal")).toBe(
        String(styles.sectionToggle.paddingHorizontal),
      );
      expect(button.style.paddingTop).toBe(`${styles.sectionToggle.paddingTop}px`);
      expect(button.style.minHeight).toBe("44px");
      expect(button.style.width).toBe("100%");
      const label = button.querySelector("span")!;
      expect(label.style.fontSize).toBe(`${styles.sectionTitle.fontSize}px`);
      expect(label.style.fontWeight).toBe(
        (styles.sectionTitle as { fontWeight?: string }).fontWeight ?? "",
      );
    },
  );

  it("sits at the very end of the inbox list and opens the existing Archived screen", () => {
    act(() => root.render(<InboxListFooter createHint archivedCount={3} />));
    expect(Array.from(container.children, (child) => child.textContent)).toEqual([
      "Tap + to create a bot",
      "Archived3",
    ]);
    act(() => container.querySelector("button")!.click());
    expect(mocks.router.push).toHaveBeenCalledWith("/archived-bots");
  });
});

describe("archived count", () => {
  const load = mocks.loadArchived as ReturnType<typeof vi.fn<typeof loadAllArchivedChats>>;

  function Counter({ spaceId }: { spaceId: string | null }) {
    return <span>{useArchivedCount(spaceId ?? undefined, spaceId !== null)}</span>;
  }
  const show = (spaceId: string | null) =>
    act(async () => root.render(<Counter spaceId={spaceId} />));

  const lists = (bots: number, groups: number) => ({
    bots: Array.from({ length: bots }, () => ({}) as never),
    groups: Array.from({ length: groups }, () => ({}) as never),
    error: undefined,
  });

  beforeEach(() => load.mockReset());

  it("counts archived bots and groups when the inbox is shown, and waits for a session", async () => {
    load.mockResolvedValue(lists(2, 1));
    await show(null);
    expect(load).not.toHaveBeenCalled();
    await show("space-a");
    expect(load).toHaveBeenCalledOnce();
    expect(container.textContent).toBe("3");
  });

  it("recounts when a chat is archived or restored, without polling", async () => {
    load.mockResolvedValueOnce(lists(0, 0));
    await show("space-a");
    expect(container.textContent).toBe("0");
    load.mockResolvedValueOnce(lists(1, 0));
    await act(async () => notifyArchivedChatsChanged());
    expect(container.textContent).toBe("1");
    load.mockResolvedValueOnce(lists(0, 0));
    await act(async () => notifyArchivedChatsChanged());
    expect(container.textContent).toBe("0");
    expect(load).toHaveBeenCalledTimes(3);
    act(() => root.unmount());
    root = createRoot(container);
    // An unmounted inbox stops listening.
    await act(async () => notifyArchivedChatsChanged());
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("keeps a list's last count when it fails, but not across spaces", async () => {
    load.mockResolvedValueOnce(lists(2, 1));
    await show("space-a");
    load.mockResolvedValueOnce({ ...lists(0, 0), bots: null, error: new Error("offline") });
    await act(async () => notifyArchivedChatsChanged());
    expect(container.textContent).toBe("2");
    load.mockResolvedValueOnce({ ...lists(0, 0), bots: null, error: new Error("offline") });
    await show("space-b");
    expect(container.textContent).toBe("0");
  });

  it("never shows another space's count while the new space's count is loading", async () => {
    load.mockResolvedValueOnce(lists(2, 1));
    await show("space-a");
    expect(container.textContent).toBe("3");
    let finish!: (value: ReturnType<typeof lists>) => void;
    load.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    await show("space-b");
    expect(container.textContent).toBe("0");
    await act(async () => finish(lists(1, 0)));
    expect(container.textContent).toBe("1");
  });

  it("shows only the newest count when loads overlap", async () => {
    let finishOld!: (value: ReturnType<typeof lists>) => void;
    load.mockReturnValueOnce(new Promise((resolve) => (finishOld = resolve)));
    await show("space-a");
    load.mockResolvedValueOnce(lists(1, 0));
    await act(async () => notifyArchivedChatsChanged());
    await act(async () => finishOld(lists(5, 5)));
    expect(container.textContent).toBe("1");
  });
});

describe("thread menu archive notifications", () => {
  function renderActions() {
    let actions: { text: string; onPress: () => void }[] = [];
    function Header() {
      actions = useThreadHeader({
        botId: "bot-b",
        inGroup: false,
        readOnly: false,
        displayName: "Bot",
        composingBots: "",
        styles: { headerActions: {} } as Parameters<typeof useThreadHeader>[0]["styles"],
        onCleared: () => undefined,
      }).botActions;
      return null;
    }
    act(() => root.render(<Header />));
    return (text: string) => actions.find((action) => action.text === text)!;
  }
  const left = () =>
    mocks.router.dismissAll.mock.calls.length === 1 &&
    mocks.router.replace.mock.calls.length === 1 &&
    mocks.router.replace.mock.calls[0]![0] === "/";

  it("notifies only after archive succeeds, including while the inbox stays mounted", async () => {
    const { listener, stop } = listenForArchiveChanges();
    const action = renderActions();
    let finish!: () => void;
    mocks.rpc.mockReturnValueOnce(new Promise<void>((resolve) => (finish = resolve)));
    action("Archive").onPress();
    expect(mocks.rpc).toHaveBeenCalledWith("bots/archive", { botId: "bot-b" });
    expect(listener).not.toHaveBeenCalled();
    expect(mocks.removeFromSearchInbox).not.toHaveBeenCalled();
    await act(async () => finish());
    expect(mocks.removeFromSearchInbox).toHaveBeenCalledWith("bot-b");
    expect(listener).toHaveBeenCalledOnce();
    expect(left()).toBe(true);
    mocks.rpc.mockRejectedValueOnce(new Error("offline"));
    action("Archive").onPress();
    await flush();
    expect(listener).toHaveBeenCalledOnce();
    expect(mocks.removeFromSearchInbox).toHaveBeenCalledOnce();
    expect(mocks.alert).toHaveBeenCalledExactlyOnceWith("Could not archive bot", "failure");
    stop();
  });

  it("notifies after confirmed deletion succeeds", async () => {
    const { listener, stop } = listenForArchiveChanges();
    const action = renderActions();
    mocks.rpc.mockResolvedValueOnce({});
    action("Delete…").onPress();
    expect(listener).not.toHaveBeenCalled();
    alertButton(0, "Keep memories").onPress!();
    await flush();
    expect(mocks.rpc).toHaveBeenCalledWith("bots/remove", {
      botId: "bot-b",
      deleteMemories: false,
    });
    expect(listener).toHaveBeenCalledOnce();
    expect(left()).toBe(true);
    stop();
  });
});

describe("group deletion archive notifications", () => {
  it("notifies after success and leaves the count unchanged on failure", async () => {
    const { listener, stop } = listenForArchiveChanges();
    let removeFails = false;
    mocks.rpc.mockImplementation((method: string) => {
      if (method === "groups/list") {
        return Promise.resolve([{ id: "group-b", name: "Group", members: [] }]);
      }
      if (method === "bots/list") return Promise.resolve([]);
      return removeFails ? Promise.reject(new Error("offline")) : Promise.resolve({});
    });
    await act(async () => root.render(<GroupSettingsScreen />));
    const deleteGroup = () =>
      Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent === "Delete group",
      )!;

    act(() => deleteGroup().click());
    alertButton(0, "Delete").onPress!();
    expect(listener).not.toHaveBeenCalled();
    await flush();
    expect(mocks.rpc).toHaveBeenCalledWith("groups/remove", { groupId: "group-b" });
    expect(listener).toHaveBeenCalledOnce();
    expect(mocks.router.replace).toHaveBeenCalledWith("/");

    removeFails = true;
    act(() => deleteGroup().click());
    alertButton(1, "Delete").onPress!();
    await flush();
    expect(listener).toHaveBeenCalledOnce();
    expect(mocks.alert).toHaveBeenLastCalledWith("Could not delete group", "failure");
    stop();
  });
});
