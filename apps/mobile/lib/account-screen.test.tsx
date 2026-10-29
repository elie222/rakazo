// @vitest-environment jsdom

import type { AccountSecurity } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Account from "../app/(settings)/account";
import { deleteAccount, fetchAccountSecurity, requestAccountDeletionCode } from "./api";
import { replaceWithSignIn } from "./auth-routing";
import { promptAccountDeletion } from "./delete-account-prompt";
import { registerSettingsSheet } from "./settings-sheet";

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
  },
}));

vi.mock("./side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("expo-notifications", () => ({
  getPermissionsAsync: vi.fn(async () => ({ status: "granted" })),
}));
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
vi.mock("react-native-safe-area-context", () => ({ SafeAreaView: element("div") }));
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
  NativeSegmentedControl: ({ accessibilityLabel }: { accessibilityLabel: string }) =>
    createElement("div", { "aria-label": accessibilityLabel }),
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
    method === "me"
      ? account.me
      : method === "autoReview/get"
        ? account.approvals
        : method === "approvalRules/list"
          ? account.rules
          : {},
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
vi.mock("./ui-locale", () => ({ UI_LOCALE_LABELS: { en: "English" } }));
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
  vi.mocked(fetchAccountSecurity).mockResolvedValue(security());
});

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

  expect(container.querySelector('[aria-label="Appearance"]')).not.toBeNull();
  expect(container.textContent).toContain("Language");
  expect(container.querySelector('[aria-label="Avatar style"]')).toBeNull();
  expect(container.textContent).not.toContain("Avatars");
  expect(container.textContent).not.toContain("Robot");
  expect(container.textContent).not.toContain("Organic");
});

async function renderAccount() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<Account />));
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

it("asks for the current password, shows a failed delete, and signs out after a successful one", async () => {
  const view = await renderAccount();
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
  const view = await renderAccount();
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
  const view = await renderAccount();
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
  const view = await renderAccount();
  await view.press("Delete account");
  await view.press("Delete");
  expect(deleteAccount).toHaveBeenCalledWith(undefined, undefined);
  expect(replaceWithSignIn).toHaveBeenCalledWith("/sign-in");
});

it("submits only a trimmed deletion code, never whitespace", async () => {
  vi.mocked(fetchAccountSecurity).mockResolvedValue(
    security({ hasPassword: false, emailDeletion: true }),
  );
  const view = await renderAccount();
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
    const view = await renderAccount();
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
  const view = await renderAccount();
  expect(view.button("Change password")).toBeUndefined();
});

it.each([false, true])(
  "keeps account navigation free of server controls (stored owner: %s)",
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
        "Artifacts",
        "Models",
        "Voice",
        "Approvals",
        "Vault",
        "Integrations",
        "Skills",
        "Messaging",
        "AI data sharing",
      ];
      const start = titles.indexOf("Artifacts");
      expect(titles.slice(start, start + links.length)).toEqual(links);
      expect(titles[start + links.length]).toBe("Advanced");
      const artifacts = view.button("Artifacts")!;
      expect(artifacts.getAttribute("role")).toBe("button");
      expect(artifacts.dataset.chevron).toBe("right");

      // Artifacts lives on the root stack, so it closes the settings sheet first.
      await view.press("Artifacts");
      expect(events).toEqual(["close", "/artifacts"]);
      for (const [title, href] of [
        ["Models", "/models"],
        ["Vault", "/vault"],
        ["Messaging", "/messaging"],
      ]) {
        events.length = 0;
        await view.press(title!);
        expect(events).toEqual([href]);
      }

      // The links wait while a deletion is in flight.
      vi.mocked(deleteAccount).mockReturnValueOnce(new Promise(() => undefined));
      await view.press("Delete account");
      await view.type("Current password", "hunter2");
      await view.press("Delete");
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
  await act(async () => root?.render(<Account />));
  expect(container.querySelector('[aria-label="Trusted sites"]')).toBeNull();

  trusted.sites = ["alice.github.io", "example.com"];
  await act(async () => root?.render(<Account />));
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
