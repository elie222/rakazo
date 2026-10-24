// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import Account from "../app/(settings)/account";

const { element } = vi.hoisted(() => ({
  element:
    (tag: string) =>
    ({ children, accessibilityLabel }: { children?: ReactNode; accessibilityLabel?: string }) =>
      createElement(tag, { "aria-label": accessibilityLabel }, children),
}));

vi.mock("expo-notifications", () => ({
  getPermissionsAsync: vi.fn(async () => ({ status: "granted" })),
}));
vi.mock("react-native", () => ({
  ActivityIndicator: () => null,
  Alert: { alert: vi.fn() },
  AppState: { addEventListener: () => ({ remove: () => undefined }) },
  KeyboardAvoidingView: element("div"),
  Modal: ({ children, visible }: { children?: ReactNode; visible?: boolean }) =>
    visible ? createElement("section", null, children) : null,
  Platform: { OS: "ios", Version: 27 },
  Pressable: element("button"),
  ScrollView: element("div"),
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
  Text: element("span"),
  TextInput: () => createElement("input"),
  View: element("div"),
}));
vi.mock("@expo/ui/community/menu", () => ({ MenuView: element("div") }));
const { router } = vi.hoisted(() => ({ router: { push: () => undefined, back: () => undefined } }));
vi.mock("expo-router", () => ({
  useFocusEffect: (effect: () => undefined | (() => void)) => useEffect(effect, [effect]),
  useLocalSearchParams: () => ({}),
  useRouter: () => router,
}));
vi.mock("react-native-safe-area-context", () => ({ SafeAreaView: element("div") }));
vi.mock("../components/app-mark", () => ({ AppMark: () => null }));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({ label }: { label: string }) =>
    createElement("button", { type: "button" }, label),
}));
vi.mock("../components/native-segmented-control", () => ({
  NativeSegmentedControl: ({ accessibilityLabel }: { accessibilityLabel: string }) =>
    createElement("div", { "aria-label": accessibilityLabel }),
}));
vi.mock("../components/settings-group", () => ({
  SettingsGroup: element("div"),
  SettingsLabel: element("span"),
  SettingsRow: ({ title }: { title: string }) => createElement("button", { type: "button" }, title),
  SettingsSwitch: ({ title }: { title: string }) =>
    createElement("button", { type: "button" }, title),
  useStackedSettings: () => false,
}));
vi.mock("./api", () => ({
  currentApiBase: () => "http://127.0.0.1:3100",
  deleteAccount: vi.fn(),
  fetchAccountSecurity: vi.fn(async () => ({ hasPassword: true })),
  loadSessionToken: vi.fn(async () => "token"),
  passwordResetCapabilities: vi.fn(async () => ({})),
  requestAccountDeletionCode: vi.fn(),
  rpc: vi.fn(async (method: string) =>
    method === "me" ? { userId: "user-1", name: "Tester", email: "tester@example.test" } : {},
  ),
  selectedSpaceId: () => "space-1",
  signOut: vi.fn(),
  updateAccountName: vi.fn(),
}));
vi.mock("./app-version", () => ({
  formatUpdateLabel: () => "",
  getAppVersionInfo: () => ({ version: "1.0.0", build: "1" }),
}));
vi.mock("./appearance", () => ({
  getCachedAppearancePreference: () => "system",
  mobileTokens: () => ({}),
  setAppearancePreference: vi.fn(),
}));
vi.mock("./archived-chats", () => ({
  archivedChatCounts: () => ({ bots: 0, groups: 0 }),
  loadArchivedChats: vi.fn(async () => ({ bots: [], groups: [] })),
}));
vi.mock("./auth-routing", () => ({ replaceWithSignIn: vi.fn() }));
vi.mock("./delete-account-prompt", () => ({ promptAccountDeletion: vi.fn() }));
vi.mock("./i18n", () => {
  // Stable across renders, as the real hook's is.
  const i18n = { t: (text: string) => text, locale: "en" };
  return { dateLocaleForUi: () => "en", useI18n: () => i18n };
});
vi.mock("./live-notifications", () => ({
  canPostPromotedNotifications: vi.fn(async () => false),
  DEFAULT_LIVE_NOTIFICATION_SETTINGS: {},
  getLiveNotificationSettings: vi.fn(async () => ({})),
  hasLiveUpdateSettings: () => false,
  openLiveNotificationSettings: vi.fn(),
  openPromotedNotificationSettings: vi.fn(),
  setLiveNotificationSettings: vi.fn(),
}));
const { styles } = vi.hoisted(() => ({ styles: new Proxy({}, { get: () => ({}) }) }));
vi.mock("./native", () => ({
  native: new Proxy({}, { get: () => "#000" }),
  useResolvedAppearance: () => "light",
  useThemedStyles: () => styles,
}));
vi.mock("./passkey", () => ({
  addPasskey: vi.fn(),
  deletePasskey: vi.fn(),
  listPasskeys: vi.fn(async () => []),
  passkeysAvailable: vi.fn(async () => false),
  renamePasskey: vi.fn(),
}));
vi.mock("./push", () => ({ registerPushToken: vi.fn() }));
vi.mock("./queued-save", () => ({ createQueuedSave: () => ({ save: vi.fn() }) }));
vi.mock("./remote-images-preference", () => ({
  getCachedRemoteImagesEnabled: () => true,
  setRemoteImagesPreference: vi.fn(),
  subscribeRemoteImages: () => () => undefined,
}));
vi.mock("./response-streaming", () => ({
  getCachedResponseStreamingEnabled: () => true,
  setResponseStreamingPreference: vi.fn(),
  subscribeResponseStreaming: () => () => undefined,
}));
vi.mock("./section-name-prompt", () => ({ promptSectionName: vi.fn() }));
vi.mock("./settings-sheet", () => ({
  isSettingsLink: () => false,
  openFromSettingsSheet: vi.fn(),
}));
vi.mock("./sso", () => ({ continueWithSso: vi.fn() }));
vi.mock("./ui-locale", () => ({ UI_LOCALE_LABELS: { en: "English" } }));
vi.mock("./user-error", () => ({ errorText: (_: unknown, fallback: string) => fallback }));

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.unstubAllGlobals();
});

it("offers no avatar style choice in account settings", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<Account />));

  // The screen rendered its neighbouring settings.
  expect(container.querySelector('[aria-label="Appearance"]')).not.toBeNull();
  expect(container.textContent).toContain("Language");
  expect(container.querySelector('[aria-label="Avatar style"]')).toBeNull();
  expect(container.textContent).not.toContain("Avatars");
  expect(container.textContent).not.toContain("Robot");
  expect(container.textContent).not.toContain("Organic");
});
