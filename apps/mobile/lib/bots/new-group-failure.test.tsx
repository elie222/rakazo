// @vitest-environment jsdom

import type { Deferred } from "@rakazo/core/test-async";
import { deferred } from "@rakazo/core/test-async";
import { notifyManager } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import NewGroup from "../../app/new-group";
import type { MobileBot } from "../api/mobile-types";
import { queryClient } from "../query/query";

const { rpc, announce, haptic, back, replace, session } = vi.hoisted(() => ({
  rpc: vi.fn(),
  announce: vi.fn(),
  haptic: vi.fn(),
  back: vi.fn(),
  replace: vi.fn(),
  session: { generation: 4, apiBase: "http://api.test", focused: true, selectedSpace: "space-1" },
}));
vi.mock("../layout/side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("../api/api", () => ({
  rpc,
  currentApiBase: () => "http://api.test",
  selectedSpaceId: () => session.selectedSpace,
  captureApiRequestContext: async (spaceId: string | null = session.selectedSpace) => ({
    apiBase: "http://api.test",
    sessionGeneration: 1,
    headers: spaceId ? { "x-rakazo-space-id": spaceId } : {},
  }),
}));
vi.mock("../api/session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("../native/haptics", () => ({ hapticSuccess: haptic }));
vi.mock("../search/search-inbox", () => ({
  addToSearchInbox: vi.fn(),
  searchInboxSession: () => ({ generation: session.generation, apiBase: session.apiBase }),
  isSearchInboxSession: (askedIn: typeof session) =>
    askedIn.generation === session.generation && askedIn.apiBase === session.apiBase,
}));
vi.mock("expo-router/react-navigation", () => ({ useHeaderHeight: () => 56 }));
vi.mock("expo-router", () => ({
  useNavigation: () => ({ isFocused: () => session.focused }),
  Stack: {
    Screen: ({
      options,
    }: {
      options: { headerLeft: () => ReactNode; headerRight: () => ReactNode };
    }) => (
      <header>
        {options.headerLeft()}
        {options.headerRight()}
      </header>
    ),
  },
  useRouter: () => ({
    back,
    push: vi.fn(),
    replace,
    canDismiss: () => false,
    canGoBack: () => false,
  }),
  useLocalSearchParams: () => ({ groupId: "group-1" }),
}));
vi.mock("react-native", () => {
  const View = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Platform: { OS: "ios" },
    AccessibilityInfo: { announceForAccessibility: announce },
    BackHandler: { addEventListener: () => ({ remove: () => undefined }) },
    View,
    ScrollView: View,
    Pressable: ({
      children,
      onPress,
      disabled,
      accessibilityLabel,
    }: {
      children?: ReactNode;
      onPress: () => void;
      disabled?: boolean;
      accessibilityLabel?: string;
    }) => (
      <button type="button" onClick={onPress} disabled={disabled} aria-label={accessibilityLabel}>
        {children}
      </button>
    ),
    Text: ({
      children,
      accessibilityRole,
    }: {
      children?: ReactNode;
      accessibilityRole?: string;
    }) => <span role={accessibilityRole}>{children}</span>,
    TextInput: ({
      value,
      onChangeText,
      accessibilityLabel,
      placeholder,
      editable,
    }: {
      value: string;
      onChangeText: (value: string) => void;
      accessibilityLabel?: string;
      placeholder?: string;
      editable?: boolean;
    }) => (
      <input
        value={value}
        disabled={editable === false}
        onChange={(event) => onChangeText(event.target.value)}
        aria-label={accessibilityLabel}
        placeholder={placeholder}
      />
    ),
    StyleSheet: { create: (styles: unknown) => styles },
    Alert: { alert: vi.fn() },
  };
});
vi.mock("react-native-keyboard-controller", () => ({
  KeyboardAvoidingView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../native/native", () => ({ native: {}, useMobileTokens: () => ({}) }));
vi.mock("../native/native-controls", () => ({ iosAtLeast: () => false }));
vi.mock("../../components/native/glass-icon-button", () => ({
  GlassIconButton: ({
    onPress,
    accessibilityLabel,
  }: {
    onPress: () => void;
    accessibilityLabel: string;
  }) => (
    <button type="button" onClick={onPress}>
      {accessibilityLabel}
    </button>
  ),
}));
vi.mock("../../components/native/sheet-close-button", () => ({
  SheetCloseButton: ({ onPress }: { onPress: () => void }) => (
    <button type="button" onClick={onPress}>
      Close
    </button>
  ),
}));
vi.mock("../../components/bots/group-avatar", () => ({ GroupAvatar: () => null }));
vi.mock("../../components/native/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("../../components/bots/bot-avatar", () => ({ BotAvatar: () => null }));
vi.mock("../../components/native/native-action-button", () => ({
  NativeActionButton: ({
    label,
    onPress,
    disabled,
  }: {
    label: string;
    onPress: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" onClick={onPress} disabled={disabled}>
      {label}
    </button>
  ),
}));
// Cache updates reach the screen inside act instead of on a later timer.
notifyManager.setScheduler((callback) => callback());

const creations = () => rpc.mock.calls.filter(([procedure]) => procedure === "groups/create");
const bots = [
  { id: "bot-1", name: "Researcher" },
  { id: "bot-2", name: "Writer" },
] as MobileBot[];
const ANSWER = "Too many group chats in this Space";
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  queryClient.clear();
  Object.assign(session, {
    generation: 4,
    apiBase: "http://api.test",
    focused: true,
    selectedSpace: "space-1",
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function button(label: string) {
  return [...container.querySelectorAll("button")].find(
    (item) => (item.getAttribute("aria-label") ?? item.textContent) === label,
  );
}
async function click(label: string) {
  expect(button(label)).toBeDefined();
  await act(async () => button(label)!.click());
}
async function start(answer: (procedure: string) => Promise<unknown>) {
  rpc.mockImplementation(answer);
  await act(async () => root.render(<NewGroup />));
  await click("Writer");
  await click("Researcher");
  await click("Next");
}
/** Create is refused with the server's message each time it is tried. */
async function refused(procedure: string) {
  if (procedure === "bots/list") return bots;
  throw new Error(ANSWER);
}
const alertText = () => container.querySelector('[role="alert"]')?.textContent;

it("announces a failed creation once, as an alert, with the text the screen shows", async () => {
  await start(refused);
  await click("Skip");
  await vi.waitFor(() => expect(announce).toHaveBeenCalledOnce());
  expect(announce).toHaveBeenLastCalledWith(ANSWER);
  expect(alertText()).toBe(ANSWER);
});

it("announces a retry that fails again, once more, with the same text", async () => {
  await start(refused);
  await click("Skip");
  await vi.waitFor(() => expect(announce).toHaveBeenCalledOnce());
  await click("Skip");
  await vi.waitFor(() => expect(announce).toHaveBeenCalledTimes(2));
  expect(creations()).toHaveLength(2);
  expect(announce).toHaveBeenLastCalledWith(ANSWER);
  // A re-render with the same failure does not speak it again.
  await act(async () => root.render(<NewGroup />));
  expect(announce).toHaveBeenCalledTimes(2);
});

it("announces nothing when the creation succeeds", async () => {
  await start(async (procedure) =>
    procedure === "bots/list" ? bots : { id: "group-1", name: "Created" },
  );
  await click("Skip");
  // The success path has finished once it confirms the creation.
  await vi.waitFor(() => expect(haptic).toHaveBeenCalledOnce());
  expect(replace).toHaveBeenCalledOnce();
  expect(announce).not.toHaveBeenCalled();
});

it("announces nothing when the sheet closes before the creation fails", async () => {
  let held!: Deferred<never>;
  await start(async (procedure) => {
    if (procedure === "bots/list") return bots;
    held = deferred<never>();
    return held.promise;
  });
  await click("Skip");
  await act(async () => root.unmount());
  root = createRoot(container);
  await act(async () => held.reject(new Error(ANSWER)));
  expect(announce).not.toHaveBeenCalled();
});
