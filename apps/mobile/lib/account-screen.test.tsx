// @vitest-environment jsdom

import type { AccountSecurity } from "@rakazo/contracts";
import * as SecureStore from "expo-secure-store";
import type { ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { Alert } from "react-native";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Account from "../app/(settings)/account";
import General from "../app/(settings)/general";
import Profile from "../app/(settings)/profile";
import type * as Api from "./api";
import { rpc } from "./api";
import type * as ApiAuth from "./api-auth";
import {
  deleteAccount,
  fetchAccountSecurity,
  requestAccountDeletionCode,
  signOut,
} from "./api-auth";
import type * as ApiServer from "./api-server";
import { replaceWithSignIn } from "./auth-routing";
import { endCallBeforeSessionEnd } from "./call-session";
import { promptAccountDeletion } from "./delete-account-prompt";
import type * as Session from "./session";
import { registerSettingsSheet } from "./settings-sheet";
import type * as ThreadFeedback from "./thread-feedback";
import { hasUnsentSends } from "./thread-feedback";

type Pressed = {
  children?: ReactNode;
  accessibilityLabel?: string;
  accessibilityRole?: string;
  disabled?: boolean;
  onPress?: () => void;
};
const { element, account } = vi.hoisted(() => ({
  element:
    (tag: string) =>
    ({ children, accessibilityLabel, accessibilityRole, disabled, onPress }: Pressed) =>
      createElement(
        tag,
        { "aria-label": accessibilityLabel, role: accessibilityRole, disabled, onClick: onPress },
        children,
      ),
  account: {
    me: { userId: "user-1", name: "Tester", email: "tester@example.test" } as Record<
      string,
      unknown
    >,
    push: vi.fn(),
    approvals: { mode: "ask", enabled: false, skipApprovals: false, checkerAvailable: true },
    rules: [] as { id: string }[],
    messaging: { enabled: true },
    plans: [] as unknown[],
    billing: {} as Record<string, unknown>,
  },
}));

vi.mock("./side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("./unsent-sends", () => ({ unsentSendsRestored: vi.fn(async () => true) }));
// The unsent-message warning reads this without a screen subscription; tests flip it per case.
vi.mock("./thread-feedback", async (importOriginal) => ({
  ...(await importOriginal<typeof ThreadFeedback>()),
  hasUnsentSends: vi.fn(() => false),
}));
vi.mock("expo-notifications", () => ({
  getPermissionsAsync: vi.fn(async () => ({ status: "granted" })),
}));
// The real sign-out flow runs in one test; its store and caches need these.
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
vi.mock("./network-cache", () => ({ clearNetworkCache: vi.fn() }));
vi.mock("react-native", () => ({
  ActivityIndicator: () => null,
  Alert: { alert: vi.fn() },
  AppState: { addEventListener: () => ({ remove: () => undefined }) },
  KeyboardAvoidingView: element("div"),
  Modal: ({ children, visible = true }: { children?: ReactNode; visible?: boolean }) =>
    visible ? createElement("section", null, children) : null,
  Platform: { OS: "ios", Version: 27 },
  Pressable: element("button"),
  ScrollView: element("div"),
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
  Text: element("span"),
  TextInput: ({
    accessibilityLabel,
    editable,
    onChangeText,
    secureTextEntry,
    value,
  }: {
    accessibilityLabel?: string;
    editable?: boolean;
    onChangeText?: (value: string) => void;
    secureTextEntry?: boolean;
    value?: string;
  }) =>
    createElement("input", {
      "aria-label": accessibilityLabel,
      disabled: editable === false,
      onChange: (event: { target: { value: string } }) => onChangeText?.(event.target.value),
      type: secureTextEntry ? "password" : "text",
      value,
    }),
  View: element("div"),
}));
vi.mock("@expo/ui/community/menu", () => ({
  MenuView: ({
    children,
    actions,
    onPressAction,
  }: {
    children?: ReactNode;
    actions: Array<{ id: string; title: string }>;
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
  }) =>
    createElement(
      "div",
      null,
      children,
      actions.map((action) =>
        createElement(
          "button",
          {
            key: action.id,
            type: "button",
            "data-menu-action": action.id,
            onClick: () => onPressAction({ nativeEvent: { event: action.id } }),
          },
          action.title,
        ),
      ),
    ),
}));
vi.mock("expo-router", () => {
  const router = { push: account.push, back: () => undefined };
  return {
    useFocusEffect: (effect: () => undefined | (() => void)) => useEffect(effect, [effect]),
    useLocalSearchParams: () => ({}),
    useRouter: () => router,
  };
});
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: element("div"),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("../components/app-mark", () => ({ AppMark: () => null }));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({
    label,
    disabled,
    onPress,
  }: {
    label: string;
    disabled?: boolean;
    onPress?: () => void;
  }) => createElement("button", { type: "button", disabled, onClick: onPress }, label),
}));
vi.mock("../components/native-segmented-control", () => ({
  NativeSegmentedControl: ({
    accessibilityLabel,
    value,
    options,
    onChange,
  }: {
    accessibilityLabel: string;
    value: string;
    options: { value: string; label: string }[];
    onChange: (value: string) => void;
  }) =>
    createElement(
      "div",
      { "aria-label": accessibilityLabel },
      options.map((option) =>
        createElement(
          "button",
          {
            type: "button",
            key: option.value,
            "aria-pressed": value === option.value,
            onClick: () => onChange(option.value),
          },
          option.label,
        ),
      ),
    ),
}));
vi.mock("../components/settings-group", () => ({
  SettingsGroup: element("div"),
  SettingsLabel: element("span"),
  SettingsRow: ({
    title,
    value,
    accessibilityRole,
    chevron,
    disabled,
    onPress,
  }: {
    title: string;
    value?: string;
    accessibilityRole?: string;
    chevron?: string;
    disabled?: boolean;
    onPress?: () => void;
  }) =>
    createElement(
      "button",
      {
        type: "button",
        role: accessibilityRole,
        "data-chevron": chevron,
        "data-value": value,
        "data-row": "",
        disabled,
        onClick: onPress,
      },
      title,
    ),
  SettingsSwitch: ({
    label,
    value,
    disabled,
    onChange,
  }: {
    label: string;
    value: boolean;
    disabled?: boolean;
    onChange: (value: boolean) => void;
  }) =>
    createElement(
      "button",
      {
        type: "button",
        role: "switch",
        "aria-label": label,
        "aria-checked": value,
        disabled,
        onClick: () => onChange(!value),
      },
      label,
    ),
  useStackedSettings: () => false,
}));
vi.mock("./api-server", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiServer>()),
}));
vi.mock("./api-live", () => ({}));
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof Api>()),
  currentApiBase: () => "http://127.0.0.1:3100",
  rpc: vi.fn(async (method: string) =>
    method === "me"
      ? account.me
      : method === "autoReview/get"
        ? account.approvals
        : method === "approvalRules/list"
          ? account.rules
          : method === "messaging/status"
            ? account.messaging
            : method === "usage/limits"
              ? account.plans
              : method === "billing/status"
                ? account.billing
                : {},
  ),
  selectedSpaceId: () => "space-1",
}));
vi.mock("./api-auth", () => ({
  deleteAccount: vi.fn(),
  fetchAccountSecurity: vi.fn(async () => ({ hasPassword: true })),
  passwordResetCapabilities: vi.fn(async () => ({})),
  requestAccountDeletionCode: vi.fn(),
  signOut: vi.fn(),
  updateAccountName: vi.fn(),
}));
vi.mock("./session", async (importOriginal) => ({
  ...(await importOriginal<typeof Session>()),
  loadSessionToken: vi.fn(async () => "token"),
}));
vi.mock("./app-version", () => ({
  formatUpdateLabel: () => "",
  getAppVersionInfo: () => ({ version: "1.0.0", build: "1" }),
}));
const storeUpdate = vi.hoisted(() => ({ available: false, open: vi.fn() }));
vi.mock("./store-update", () => ({
  openStoreListing: storeUpdate.open,
  useStoreUpdateAvailable: () => storeUpdate.available,
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
vi.mock("./call-session", () => ({ endCallBeforeSessionEnd: vi.fn(async () => undefined) }));
vi.mock("./delete-account-prompt", () => ({ promptAccountDeletion: vi.fn() }));
const haptics = vi.hoisted(() => ({
  enabled: true,
  listeners: new Set<() => void>(),
  load: vi.fn(async () => undefined),
  save: vi.fn(async (_value: boolean) => undefined),
}));
vi.mock("./haptics", () => ({
  getHapticsEnabled: () => haptics.enabled,
  loadHapticsPreference: haptics.load,
  setHapticsEnabled: (value: boolean) => {
    haptics.enabled = value;
    for (const listener of haptics.listeners) listener();
    return haptics.save(value);
  },
  subscribeHaptics: (listener: () => void) => {
    haptics.listeners.add(listener);
    return () => haptics.listeners.delete(listener);
  },
}));
vi.mock("./live-notifications", () => ({
  canPostPromotedNotifications: vi.fn(async () => false),
  DEFAULT_LIVE_NOTIFICATION_SETTINGS: {},
  getLiveNotificationSettings: vi.fn(async () => ({})),
  hasLiveUpdateSettings: () => false,
  openLiveNotificationSettings: vi.fn(),
  openPromotedNotificationSettings: vi.fn(),
  resumeLiveNotifications: vi.fn(async () => undefined),
  setLiveNotificationSettings: vi.fn(),
  stopLiveNotifications: vi.fn(async () => undefined),
}));
const { styles } = vi.hoisted(() => ({ styles: new Proxy({}, { get: () => ({}) }) }));
vi.mock("./native", () => ({
  native: new Proxy({}, { get: () => "#000" }),
  useMobileTokens: () => ({}),
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
vi.mock("./organizations", () => ({
  activeOrganization: () => undefined,
  useOrganizations: () => ({ data: undefined }),
}));
vi.mock("./push", () => ({ registerPushToken: vi.fn() }));
vi.mock("./returning-user", () => ({ forgetSignedIn: vi.fn() }));
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
vi.mock("./sso", () => ({ continueWithSso: vi.fn() }));
const trusted = vi.hoisted(() => ({
  sites: [] as string[],
  remove: vi.fn(async (_site: string) => undefined),
}));
vi.mock("./trusted-link-sites", () => ({
  loadTrustedLinkSites: vi.fn(async () => undefined),
  removeTrustedLinkSite: trusted.remove,
  useTrustedLinkSites: () => trusted.sites,
}));
vi.mock("./user-error", () => ({ errorText: (_: unknown, fallback: string) => fallback }));

function security(overrides: Partial<AccountSecurity> = {}): AccountSecurity {
  return {
    hasPassword: true,
    freshOidcAuth: false,
    ssoLinked: false,
    emailDeletion: false,
    sso: null,
    ...overrides,
  };
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  account.me = { userId: "user-1", name: "Tester", email: "tester@example.test" };
  account.rules = [];
  account.messaging = { enabled: true };
  account.plans = [];
  account.billing = {};
  haptics.enabled = true;
  storeUpdate.available = false;
  haptics.listeners.clear();
  haptics.save.mockReset().mockResolvedValue(undefined);
  haptics.load.mockReset().mockResolvedValue(undefined);
  vi.mocked(fetchAccountSecurity).mockResolvedValue(security());
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("keeps bot style visible when the account has no saved style", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<General />));

  expect(container.querySelector('[aria-label="Appearance"]')).not.toBeNull();
  expect(container.textContent).toContain("Language");
  expect(container.querySelector('[aria-label="Bot style"]')).not.toBeNull();
  expect(container.textContent).not.toContain("Avatars");
  expect(container.textContent).not.toContain("Robot");
  expect(container.textContent).not.toContain("Organic");
});

it("saves an Original choice even when the saved style is absent", async () => {
  const { screen } = await renderAccount(General);
  const picker = screen.querySelector('[aria-label="Bot style"]')!;
  const original = Array.from(picker.querySelectorAll("button")).find(
    (node) => node.textContent === "Original",
  )!;
  expect(original.getAttribute("aria-pressed")).toBe("false");
  vi.mocked(rpc).mockResolvedValueOnce({ ...account.me, botAvatarSet: "organic" } as never);
  await act(async () => original.click());
  expect(original.getAttribute("aria-pressed")).toBe("true");
  expect(rpc).toHaveBeenCalledWith("preferences/update", { botAvatarSet: "organic" });
});

async function renderAccount(Screen: () => ReactNode = Account) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<Screen />));
  const screen = container;
  const button = (name: string) =>
    Array.from(screen.querySelectorAll("button")).find((node) => node.textContent === name);
  return {
    screen,
    button,
    press: async (name: string) => {
      const target = button(name);
      if (!target) throw new Error(`No ${name} button`);
      await act(async () => target.click());
    },
    type: async (label: string, value: string) => {
      const input = screen.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      await act(async () => {
        setValue.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    },
    alert: () => screen.querySelector('[role="alert"]')?.textContent ?? null,
  };
}

it("navigates to sign-in while a silent server still owes the sign-out delivery", async () => {
  const actual = await vi.importActual<typeof ApiAuth>("./api-auth");
  const store = new Map<string, string>([["rakazo.session_token", "session-token"]]);
  vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => store.get(key) ?? null);
  vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
    store.set(key, value);
  });
  vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
    store.delete(key);
  });
  vi.mocked(signOut).mockImplementation(actual.signOut);
  vi.stubGlobal(
    "fetch",
    vi.fn((_input: string) => new Promise<Response>(() => undefined)),
  );

  const view = await renderAccount();
  try {
    vi.useFakeTimers();
    await view.press("Sign out");

    // The screen leaves before the request timeout fires; the device is signed out.
    expect(replaceWithSignIn).toHaveBeenCalled();
    expect(store.has("rakazo.session_token")).toBe(false);
    expect(JSON.parse(store.get("rakazo.pending_sign_out") ?? "[]")).toHaveLength(1);

    // The delivery still runs: it times out and the record waits for retry.
    await vi.advanceTimersByTimeAsync(8_000);
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3100/api/auth/sign-out",
      expect.anything(),
    );
    expect(JSON.parse(store.get("rakazo.pending_sign_out") ?? "[]")).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
});

it("offers a store update beside the version only when one is available", async () => {
  const view = await renderAccount();
  expect(view.button("Update")).toBeUndefined();
  act(() => root?.unmount());

  storeUpdate.available = true;
  const updatable = await renderAccount();
  await updatable.press("Update");
  expect(storeUpdate.open).toHaveBeenCalled();
});

it("shows a device haptics switch that follows and saves the local preference", async () => {
  haptics.enabled = false;
  const view = await renderAccount(General);
  const toggle = view.screen.querySelector<HTMLButtonElement>(
    '[role="switch"][aria-label="Haptics"]',
  );
  expect(toggle?.getAttribute("aria-checked")).toBe("false");
  await view.press("Haptics");
  expect(haptics.save).toHaveBeenLastCalledWith(true);
  expect(toggle?.getAttribute("aria-checked")).toBe("true");
  await view.press("Haptics");
  expect(haptics.save).toHaveBeenLastCalledWith(false);
  expect(toggle?.getAttribute("aria-checked")).toBe("false");
});

it("requests the cached haptics loader on each settings visit without repeating it on rerenders", async () => {
  const first = await renderAccount(General);
  expect(haptics.load).toHaveBeenCalledOnce();
  await first.press("Haptics");
  expect(haptics.load).toHaveBeenCalledOnce();
  await act(async () => root?.unmount());
  root = undefined;
  first.screen.remove();
  await renderAccount(General);
  expect(haptics.load).toHaveBeenCalledTimes(2);
});

it("reflects a saved off choice recovered by the settings focus loader", async () => {
  haptics.load.mockImplementationOnce(async () => {
    haptics.enabled = false;
    for (const listener of haptics.listeners) listener();
  });
  const view = await renderAccount(General);
  expect(
    view.screen
      .querySelector('[role="switch"][aria-label="Haptics"]')
      ?.getAttribute("aria-checked"),
  ).toBe("false");
  expect(haptics.load).toHaveBeenCalledOnce();
  expect(haptics.save).not.toHaveBeenCalled();
});

it("keeps a failed off choice in memory and offers a native retry of that same choice", async () => {
  haptics.save.mockRejectedValueOnce(new Error("private device storage failure"));
  const view = await renderAccount(General);
  await view.press("Haptics");
  const toggle = view.screen.querySelector('[role="switch"][aria-label="Haptics"]');
  expect(toggle?.getAttribute("aria-checked")).toBe("false");
  expect(Alert.alert).toHaveBeenCalledWith("Haptics", "Could not save", expect.any(Array));
  const buttons = vi.mocked(Alert.alert).mock.lastCall?.[2];
  expect(buttons?.find((button) => button.style === "cancel")?.text).toBe("Cancel");
  const retry = buttons?.find((button) => button.text === "Retry");
  expect(retry).toBeDefined();
  await act(async () => retry?.onPress?.());
  expect(haptics.save.mock.calls).toEqual([[false], [false]]);
  expect(toggle?.getAttribute("aria-checked")).toBe("false");
  expect(Alert.alert).toHaveBeenCalledOnce();
});

it("ignores a failed older toggle even when the latest choice has the same value", async () => {
  let fail!: (error: Error) => void;
  haptics.save.mockReturnValueOnce(
    new Promise<never>((_resolve, reject) => {
      fail = reject;
    }),
  );
  const view = await renderAccount(General);
  await view.press("Haptics");
  await view.press("Haptics");
  await view.press("Haptics");
  await act(async () => fail(new Error("old failure")));
  expect(haptics.save.mock.calls).toEqual([[false], [true], [false]]);
  expect(haptics.enabled).toBe(false);
  expect(Alert.alert).not.toHaveBeenCalled();
});

it("does not let an old retry overwrite a newer preference", async () => {
  haptics.save.mockRejectedValueOnce(new Error("save failed"));
  const view = await renderAccount(General);
  await view.press("Haptics");
  const retry = vi
    .mocked(Alert.alert)
    .mock.lastCall?.[2]?.find((button) => button.text === "Retry");
  await view.press("Haptics");
  expect(haptics.enabled).toBe(true);
  await act(async () => retry?.onPress?.());
  expect(haptics.save.mock.calls).toEqual([[false], [true]]);
  expect(haptics.enabled).toBe(true);
});

it("reports a current failed save and can retry after the account screen closes", async () => {
  let fail!: (error: Error) => void;
  haptics.save.mockReturnValueOnce(
    new Promise<never>((_resolve, reject) => {
      fail = reject;
    }),
  );
  const view = await renderAccount(General);
  await view.press("Haptics");
  await act(async () => root?.unmount());
  root = undefined;
  await act(async () => fail(new Error("late failure")));
  expect(haptics.enabled).toBe(false);
  expect(Alert.alert).toHaveBeenCalledWith("Haptics", "Could not save", expect.any(Array));
  const retry = vi
    .mocked(Alert.alert)
    .mock.lastCall?.[2]?.find((button) => button.text === "Retry");
  await act(async () => retry?.onPress?.());
  expect(haptics.save.mock.calls).toEqual([[false], [false]]);
});

it("keeps a late failure from an earlier settings visit silent after a newer same-value choice", async () => {
  let fail!: (error: Error) => void;
  haptics.save.mockReturnValueOnce(
    new Promise<never>((_resolve, reject) => {
      fail = reject;
    }),
  );
  const first = await renderAccount(General);
  await first.press("Haptics");
  await act(async () => root?.unmount());
  root = undefined;
  first.screen.remove();
  const second = await renderAccount(General);
  await second.press("Haptics");
  await second.press("Haptics");
  expect(haptics.enabled).toBe(false);
  await act(async () => fail(new Error("old visit failure")));
  expect(haptics.save.mock.calls).toEqual([[false], [true], [false]]);
  expect(Alert.alert).not.toHaveBeenCalled();
});

it("asks for the current password, shows a failed delete, and signs out after a successful one", async () => {
  const view = await renderAccount(Profile);
  await view.press("Delete account");
  const input = view.screen.querySelector<HTMLInputElement>('input[aria-label="Current password"]');
  expect(input?.type).toBe("password");
  expect(view.button("Delete")?.disabled).toBe(true);

  vi.mocked(deleteAccount).mockRejectedValueOnce(new Error("wrong password"));
  await view.type("Current password", "hunter2");
  await view.press("Delete");
  expect(deleteAccount).toHaveBeenCalledWith("hunter2");
  expect(view.alert()).toBe("Could not delete account");
  expect(replaceWithSignIn).not.toHaveBeenCalled();

  await view.type("Current password", "correct horse");
  expect(view.alert()).toBeNull();
  await view.press("Delete");
  expect(deleteAccount).toHaveBeenLastCalledWith("correct horse");
  expect(replaceWithSignIn).toHaveBeenCalledWith("/sign-in");
  expect(view.screen.querySelector("section")).toBeNull();
});

it("deletes with the password from the native prompt when one is shown", async () => {
  vi.mocked(promptAccountDeletion).mockReturnValueOnce(true);
  const view = await renderAccount(Profile);
  await view.press("Delete account");
  expect(view.screen.querySelector("section")).toBeNull();
  const [{ onSubmit }] = vi.mocked(promptAccountDeletion).mock.calls[0]!;
  await act(async () => onSubmit("hunter2"));
  expect(deleteAccount).toHaveBeenCalledWith("hunter2");
  expect(replaceWithSignIn).toHaveBeenCalledWith("/sign-in");
});

it("refreshes an expired sign-in proof and keeps the deletion dialog open", async () => {
  vi.mocked(fetchAccountSecurity).mockResolvedValue(
    security({ hasPassword: false, freshOidcAuth: true, sso: { name: "Example SSO" } }),
  );
  const view = await renderAccount(Profile);
  await view.press("Delete account");
  // The proof expires while the dialog is open.
  vi.mocked(fetchAccountSecurity).mockResolvedValue(
    security({ hasPassword: false, freshOidcAuth: false, sso: { name: "Example SSO" } }),
  );
  await view.press("Delete");
  expect(deleteAccount).not.toHaveBeenCalled();
  expect(replaceWithSignIn).not.toHaveBeenCalled();
  expect(view.screen.querySelector("section")).not.toBeNull();
  expect(view.button("Sign in again")?.disabled).toBe(false);
  expect(view.button("Delete")?.disabled).toBe(true);
});

it("deletes with a still-fresh sign-in proof", async () => {
  vi.mocked(fetchAccountSecurity).mockResolvedValue(
    security({ hasPassword: false, freshOidcAuth: true }),
  );
  const view = await renderAccount(Profile);
  await view.press("Delete account");
  await view.press("Delete");
  expect(deleteAccount).toHaveBeenCalledWith(undefined, undefined);
  expect(replaceWithSignIn).toHaveBeenCalledWith("/sign-in");
});

it("submits only a trimmed deletion code, never whitespace", async () => {
  vi.mocked(fetchAccountSecurity).mockResolvedValue(
    security({ hasPassword: false, emailDeletion: true }),
  );
  const view = await renderAccount(Profile);
  await view.press("Delete account");
  await view.press("Send deletion code");
  expect(requestAccountDeletionCode).toHaveBeenCalledOnce();
  const input = view.screen.querySelector<HTMLInputElement>('input[aria-label="Deletion code"]');
  expect(input?.type).toBe("text");

  await view.type("Deletion code", "   ");
  expect(view.button("Delete")?.disabled).toBe(true);
  await view.press("Delete");
  expect(deleteAccount).not.toHaveBeenCalled();

  await view.type("Deletion code", " 123456 ");
  await view.press("Delete");
  expect(deleteAccount).toHaveBeenCalledWith(undefined, "123456");
  expect(replaceWithSignIn).toHaveBeenCalledWith("/sign-in");
});

it.each([undefined, true, false])(
  "respects the password-change policy (%s) while keeping password deletion",
  async (passwordChangeEnabled) => {
    vi.mocked(fetchAccountSecurity).mockResolvedValue(security({ passwordChangeEnabled }));
    const view = await renderAccount(Profile);
    expect(Boolean(view.button("Change password"))).toBe(passwordChangeEnabled !== false);
    await view.press("Delete account");
    await view.type("Current password", "hunter2");
    await view.press("Delete");
    expect(deleteAccount).toHaveBeenCalledWith("hunter2");
  },
);

it("hides password change from an account without a password", async () => {
  vi.mocked(fetchAccountSecurity).mockResolvedValue(
    security({ hasPassword: false, passwordChangeEnabled: true }),
  );
  const view = await renderAccount(Profile);
  expect(view.button("Change password")).toBeUndefined();
});

it.each([false, true])(
  "lists the settings in order, free of server controls (stored owner: %s)",
  async (isDeploymentOwner) => {
    account.me = { ...account.me, isDeploymentOwner };
    const events: string[] = [];
    const unregister = registerSettingsSheet(() => events.push("close"));
    account.push.mockImplementation((href: string) => events.push(href));
    try {
      const view = await renderAccount();
      const titles = Array.from(
        view.screen.querySelectorAll("[data-row]"),
        (row) => row.textContent,
      );
      const links = [
        "Integrations",
        "Skills",
        "Artifacts",
        "General",
        "Models",
        "Approvals",
        "Vault",
        "Memory",
        "Voice",
        "Messaging",
        "Members",
      ];
      expect(titles).toEqual(["tester@example.test", "Usage", ...links]);
      const artifacts = view.button("Artifacts")!;
      expect(artifacts.getAttribute("role")).toBe("button");
      expect(artifacts.dataset.chevron).toBe("right");

      // Artifacts lives on the root stack, so it closes the settings sheet first.
      await view.press("Artifacts");
      expect(events).toEqual(["close", "/artifacts"]);
      for (const [title, href] of [
        ["tester@example.test", "/profile"],
        ["General", "/general"],
        ["Models", "/models"],
        ["Vault", "/vault"],
        ["Memory", "/memory"],
        ["Messaging", "/messaging"],
      ]) {
        events.length = 0;
        await view.press(title!);
        expect(events).toEqual([href]);
      }

      // The links wait while signing out.
      vi.mocked(signOut).mockReturnValueOnce(new Promise(() => undefined));
      await view.press("Sign out");
      expect(view.button("Artifacts")!.disabled).toBe(true);
    } finally {
      unregister();
    }
  },
);

it("lists trusted link sites only when there is one, each with a remove action", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<Profile />));
  expect(container.querySelector('[aria-label="Trusted sites"]')).toBeNull();

  trusted.sites = ["alice.github.io", "example.com"];
  await act(async () => root?.render(<Profile />));
  const group = container.querySelector('[aria-label="Trusted sites"]');
  expect(group?.textContent).toContain("alice.github.io");
  expect(group?.textContent).toContain("example.com");
  const removes = group?.querySelectorAll<HTMLButtonElement>('[data-menu-action="remove"]');
  expect(removes).toHaveLength(2);
  await act(async () => removes?.[1]?.click());
  expect(trusted.remove).toHaveBeenCalledWith("example.com");
  trusted.sites = [];
});

it("shows the approval mode as the Approvals row's value, with Rules only once there are some", async () => {
  let view = await renderAccount();
  const approvals = view.button("Approvals")!;
  expect(approvals.dataset.value).toBe("Ask");
  expect(approvals.dataset.chevron).toBeUndefined();
  // The mode opens a menu in place; there is no screen for it.
  await act(async () => approvals.click());
  expect(account.push).not.toHaveBeenCalled();
  expect(view.button("Rules")).toBeUndefined();

  act(() => root?.unmount());
  container?.remove();
  account.rules = [{ id: "rule-1" }, { id: "rule-2" }];
  view = await renderAccount();
  const titles = Array.from(view.screen.querySelectorAll("[data-row]"), (row) => row.textContent);
  expect(titles.slice(titles.indexOf("Approvals"), titles.indexOf("Approvals") + 3)).toEqual([
    "Approvals",
    "Rules",
    "Vault",
  ]);
  expect(view.button("Rules")!.dataset.value).toBe("2");
  await view.press("Rules");
  expect(account.push).toHaveBeenCalledWith("/approvals");
});

it("hides Messaging when no chat app is connected to the server", async () => {
  account.messaging = { enabled: false };
  const view = await renderAccount();
  const titles = Array.from(view.screen.querySelectorAll("[data-row]"), (row) => row.textContent);
  expect(titles).toContain("Skills");
  expect(titles).not.toContain("Messaging");
});

it("starts one sign-out when Sign out is tapped again while the warning is open", async () => {
  vi.mocked(hasUnsentSends).mockReturnValue(true);
  try {
    const view = await renderAccount();
    await view.press("Sign out");
    await view.press("Sign out");
    expect(Alert.alert).toHaveBeenCalledOnce();
    const buttons = vi.mocked(Alert.alert).mock.calls[0]![2]!;
    await act(async () => buttons[1]!.onPress?.());
    expect(signOut).toHaveBeenCalledOnce();
  } finally {
    vi.mocked(hasUnsentSends).mockReturnValue(false);
  }
});

it("warns before sign-out deletes unsent messages and keeps them on cancel", async () => {
  vi.mocked(hasUnsentSends).mockReturnValue(true);
  try {
    const view = await renderAccount();
    await view.press("Sign out");
    expect(Alert.alert).toHaveBeenCalledOnce();
    const buttons = vi.mocked(Alert.alert).mock.calls[0]![2]!;
    expect(buttons[0]!.text).toBe("Cancel");
    expect(buttons[1]!.text).toBe("Sign out anyway");
    // Nothing is cleared while the alert is open or after Cancel.
    expect(signOut).not.toHaveBeenCalled();
    await act(async () => buttons[0]!.onPress?.());
    expect(signOut).not.toHaveBeenCalled();
    expect(replaceWithSignIn).not.toHaveBeenCalled();

    await view.press("Sign out");
    const confirm = vi.mocked(Alert.alert).mock.calls[1]![2]!;
    await act(async () => confirm[1]!.onPress?.());
    expect(signOut).toHaveBeenCalledOnce();
    expect(replaceWithSignIn).toHaveBeenCalled();
  } finally {
    vi.mocked(hasUnsentSends).mockReturnValue(false);
  }
});

it("hangs up the active call before signing out", async () => {
  const view = await renderAccount();
  const order: string[] = [];
  vi.mocked(endCallBeforeSessionEnd).mockImplementationOnce(async () => {
    order.push("hang-up");
  });
  vi.mocked(signOut).mockImplementationOnce(async () => {
    order.push("sign-out");
  });
  await view.press("Sign out");
  expect(order).toEqual(["hang-up", "sign-out"]);
});

it("shows subscription allowances and credits only for members who have them", async () => {
  let view = await renderAccount();
  let titles = Array.from(view.screen.querySelectorAll("[data-row]"), (row) => row.textContent);
  expect(titles).not.toContain("Session");
  expect(titles).not.toContain("Credits");

  act(() => root?.unmount());
  container?.remove();
  account.plans = [
    {
      credentialId: "c1",
      name: "Claude",
      label: "Claude",
      windows: [{ period: "session", usedPercent: 37.6, resetsAt: null }],
    },
  ];
  account.billing = { funding: "credits", balanceUsd: 12.5 };
  view = await renderAccount();
  titles = Array.from(view.screen.querySelectorAll("[data-row]"), (row) => row.textContent);
  expect(titles).toContain("Session");
  expect(view.button("Session")!.dataset.value).toBe("38% used");
  expect(view.button("Credits")!.dataset.value).toBe("$12.50 left");
});
