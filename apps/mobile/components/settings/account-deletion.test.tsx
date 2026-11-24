// @vitest-environment jsdom

import type { AccountSecurity } from "@rakazo/contracts";
import { deferred, flush } from "@rakazo/core/test-async";
import { tokensForAppearance } from "@rakazo/ui-tokens";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { Platform } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promptAccountDeletion } from "../../lib/account/delete-account-prompt";
import {
  deleteAccount,
  fetchAccountSecurity,
  requestAccountDeletionCode,
} from "../../lib/auth/api-auth";
import { replaceWithSignIn } from "../../lib/auth/auth-routing";
import { forgetSignedIn } from "../../lib/auth/returning-user";
import { continueWithSso } from "../../lib/auth/sso";
import { useAccountDeletion } from "./account-deletion";

const appearance = vi.hoisted(() => ({ current: "light" as "light" | "dark" }));

vi.mock("react-native", () => {
  type Props = {
    children?: ReactNode;
    style?: Record<string, unknown>;
    accessibilityLabel?: string;
    onPress?: () => void;
    disabled?: boolean;
  };
  const view = ({ children, style }: Props) => createElement("div", { style }, children);
  return {
    Platform: { OS: "ios" },
    StyleSheet: { create: (styles: unknown) => styles, absoluteFill: {} },
    View: view,
    ScrollView: ({
      children,
      style,
      contentContainerStyle,
    }: Props & { contentContainerStyle?: unknown }) =>
      createElement(
        "div",
        { style },
        createElement(
          "div",
          {
            "data-testid": "sheet-content",
            style: Object.assign({}, ...[contentContainerStyle].flat()),
          },
          children,
        ),
      ),
    Text: ({ children }: Props) => createElement("span", null, children),
    Pressable: ({ children, accessibilityLabel, onPress, disabled }: Props) =>
      createElement(
        "button",
        { type: "button", "aria-label": accessibilityLabel, onClick: onPress, disabled },
        children,
      ),
    TextInput: ({
      onChangeText,
      value,
    }: {
      onChangeText: (value: string) => void;
      value: string;
    }) =>
      createElement("input", {
        value,
        onInput: (event) => onChangeText(event.currentTarget.value),
      }),
    Modal: ({
      children,
      transparent,
      presentationStyle,
      allowSwipeDismissal,
    }: Props & {
      transparent?: boolean;
      presentationStyle?: string;
      allowSwipeDismissal?: boolean;
    }) =>
      createElement(
        "section",
        {
          "data-transparent": String(transparent ?? false),
          "data-presentation": presentationStyle,
          "data-swipe": String(allowSwipeDismissal ?? false),
        },
        children,
      ),
  };
});
vi.mock("../native/native-action-button", () => ({
  NativeActionButton: ({
    label,
    disabled,
    onPress,
    prominence,
  }: {
    label: string;
    disabled?: boolean;
    onPress: () => void;
    prominence?: string;
  }) =>
    createElement(
      "button",
      {
        type: "button",
        disabled,
        onClick: onPress,
        "data-native-action": prominence ?? "primary",
      },
      label,
    ),
}));
vi.mock("../../lib/auth/api-auth", () => ({
  fetchAccountSecurity: vi.fn(),
  deleteAccount: vi.fn(),
  requestAccountDeletionCode: vi.fn(),
}));
vi.mock("../../lib/appearance/appearance", () => ({
  mobileTokens: () => tokensForAppearance(appearance.current),
}));
vi.mock("../../lib/native/native", () => ({
  native: {},
  useThemedStyles: (factory: () => unknown) => factory(),
}));
vi.mock("../../lib/auth/auth-routing", () => ({ replaceWithSignIn: vi.fn() }));
vi.mock("../../lib/account/delete-account-prompt", () => ({
  promptAccountDeletion: vi.fn(() => false),
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 34 }) }));
vi.mock("../../lib/auth/returning-user", () => ({ forgetSignedIn: vi.fn() }));
vi.mock("../../lib/auth/sso", () => ({ continueWithSso: vi.fn() }));

const passwordless: AccountSecurity = {
  hasPassword: false,
  sso: { name: "Example SSO" },
  ssoLinked: true,
  emailDeletion: true,
  freshOidcAuth: false,
};

let deletion: ReturnType<typeof useAccountDeletion>;
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;

function Screen() {
  deletion = useAccountDeletion();
  return deletion.dialog;
}

async function open() {
  act(() => root.render(createElement(Screen)));
  await act(() => deletion.request());
}

function button(label: string) {
  const found = [...container.querySelectorAll("button")].find(
    (node) => node.textContent === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

async function click(label: string) {
  await act(async () => button(label).click());
}

describe("passwordless account deletion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    Platform.OS = "ios";
    appearance.current = "light";
    vi.mocked(fetchAccountSecurity).mockResolvedValue(passwordless);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("uses an iOS system sheet and native cancel and destructive controls", async () => {
    await open();
    const sheet = container.querySelector("section")!;
    expect(sheet.dataset.presentation).toBe("pageSheet");
    // The sheet can be swiped away while nothing is in flight; the swipe goes through close().
    expect(sheet.dataset.swipe).toBe("true");
    expect(sheet.dataset.transparent).toBe("false");
    // The actions stay clear of the home indicator.
    const content = container.querySelector<HTMLElement>("[data-testid='sheet-content']")!;
    expect(content.style.paddingBottom).toBe("52px");
    expect((sheet.firstElementChild as HTMLElement).style.paddingBottom).toBe("");
    expect(button("Delete").dataset.nativeAction).toBe("destructive");
    expect(button("Delete").disabled).toBe(true);
    expect(button("Cancel").dataset.nativeAction).toBe("plain");
    await click("Cancel");
    expect(container.querySelector("section")).toBeNull();
    expect(deleteAccount).not.toHaveBeenCalled();
  });

  it.each(["light", "dark"] as const)("uses the shared %s overlay on Android", async (theme) => {
    Platform.OS = "android";
    appearance.current = theme;
    await open();
    const sheet = container.querySelector("section")!;
    const overlay = sheet.firstElementChild as HTMLElement;
    const expected = document.createElement("div");
    expected.style.backgroundColor = tokensForAppearance(theme).overlay;
    expect(sheet.dataset.transparent).toBe("true");
    expect(overlay.style.backgroundColor).toBe(expected.style.backgroundColor);
  });

  it("keeps deletion disabled until a fresh SSO sign-in and deletes after confirmation", async () => {
    vi.mocked(continueWithSso).mockResolvedValue(true);
    await open();
    await click("Sign in again");
    expect(button("Delete").disabled).toBe(false);
    expect(deleteAccount).not.toHaveBeenCalled();
    vi.mocked(fetchAccountSecurity).mockResolvedValue({ ...passwordless, freshOidcAuth: true });
    await click("Delete");
    expect(deleteAccount).toHaveBeenCalledExactlyOnceWith(undefined, undefined);
    expect(forgetSignedIn).toHaveBeenCalledOnce();
    expect(replaceWithSignIn).toHaveBeenCalledExactlyOnceWith("/sign-in");
  });

  it("cannot be swiped away while a deletion is in flight", async () => {
    vi.mocked(continueWithSso).mockResolvedValue(true);
    const fail = deferred<never>();
    vi.mocked(deleteAccount).mockReturnValue(fail.promise as never);
    await open();
    await click("Sign in again");
    vi.mocked(fetchAccountSecurity).mockResolvedValue({ ...passwordless, freshOidcAuth: true });
    await click("Delete");
    expect(container.querySelector("section")!.dataset.swipe).toBe("false");
    await act(async () => fail.reject(new Error("offline")));
    expect(container.querySelector("section")!.dataset.swipe).toBe("true");
  });

  it("keeps the emailed code flow available in the sheet", async () => {
    await open();
    await click("Send deletion code");
    expect(requestAccountDeletionCode).toHaveBeenCalledOnce();
    expect(button("Delete").disabled).toBe(true);
    const input = container.querySelector("input")!;
    act(() => {
      input.value = "123456";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(button("Delete").disabled).toBe(false);
    await click("Delete");
    expect(deleteAccount).toHaveBeenCalledExactlyOnceWith(undefined, "123456");
  });

  it("explains when the fresh sign-in proof expired before Delete", async () => {
    vi.mocked(continueWithSso).mockResolvedValue(true);
    await open();
    await click("Sign in again");
    expect(button("Delete").disabled).toBe(false);
    // The re-fetch answers with an expired proof: the sheet was open longer than it lasts.
    vi.mocked(fetchAccountSecurity).mockResolvedValue({ ...passwordless, freshOidcAuth: false });
    await click("Delete");
    expect(deleteAccount).not.toHaveBeenCalled();
    expect(
      [...container.querySelectorAll("span")].some((node) => node.textContent === "Sign in again"),
    ).toBe(true);
    expect(button("Delete").disabled).toBe(true);
  });

  it("clears the code field when the account gains a password mid-dialog", async () => {
    await open();
    await click("Send deletion code");
    const input = container.querySelector("input")!;
    act(() => {
      input.value = "123456";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(button("Delete").disabled).toBe(false);
    vi.mocked(fetchAccountSecurity).mockResolvedValue({ ...passwordless, hasPassword: true });
    await click("Delete");
    expect(deleteAccount).not.toHaveBeenCalled();
    // The field switched to the password mode; the code must not sit in it as a password.
    expect(input.value).toBe("");
    expect(button("Delete").disabled).toBe(true);
  });

  it.each(["google", "apple"])("hides unsupported linked %s deletion confirmation", async (id) => {
    vi.mocked(fetchAccountSecurity).mockResolvedValue({
      ...passwordless,
      hasPassword: false,
      sso: null,
      ssoLinked: false,
      emailDeletion: false,
      linkedProviderIds: [id],
    });
    await open();
    expect(document.body.textContent).not.toContain("Continue with Provider");
    expect(continueWithSso).not.toHaveBeenCalled();
    expect(button("Delete").disabled).toBe(true);
  });
});

describe("account deletion security read", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    Platform.OS = "ios";
    vi.mocked(fetchAccountSecurity).mockResolvedValue(passwordless);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => root.render(createElement(Screen)));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("is pending while the read runs and opens one dialog for a second request", async () => {
    const read = deferred<AccountSecurity>();
    vi.mocked(fetchAccountSecurity).mockReturnValue(read.promise);
    act(() => {
      void deletion.request();
      void deletion.request();
    });
    expect(deletion.pending).toBe(true);
    expect(fetchAccountSecurity).toHaveBeenCalledOnce();
    await act(async () => {
      read.resolve(passwordless);
      await flush();
    });
    expect(deletion.pending).toBe(false);
    expect(promptAccountDeletion).not.toHaveBeenCalled();
    expect(container.querySelectorAll("section")).toHaveLength(1);
  });

  it("prompts once for a password account when requested twice", async () => {
    const read = deferred<AccountSecurity>();
    vi.mocked(fetchAccountSecurity).mockReturnValue(read.promise);
    act(() => {
      void deletion.request();
      void deletion.request();
    });
    expect(deletion.pending).toBe(true);
    await act(async () => {
      read.resolve({ ...passwordless, hasPassword: true });
      await flush();
    });
    expect(promptAccountDeletion).toHaveBeenCalledOnce();
    expect(deletion.pending).toBe(false);
  });

  it("keeps pending for a sign-in action that a request raced before the render", async () => {
    const signIn = deferred<void>();
    const action = vi.fn(() => signIn.promise);
    act(() => {
      void deletion.run(action);
      void deletion.request();
    });
    expect(action).toHaveBeenCalledOnce();
    expect(fetchAccountSecurity).not.toHaveBeenCalled();
    expect(deletion.pending).toBe(true);
    await act(async () => {
      signIn.resolve();
      await flush();
    });
    expect(deletion.pending).toBe(false);
  });

  it("does not start a sign-in action while the read is running", async () => {
    const read = deferred<AccountSecurity>();
    vi.mocked(fetchAccountSecurity).mockReturnValue(read.promise);
    const action = vi.fn(async () => {});
    act(() => {
      void deletion.request();
      void deletion.run(action);
    });
    expect(action).not.toHaveBeenCalled();
    await act(async () => {
      read.resolve(passwordless);
      await flush();
    });
    expect(deletion.pending).toBe(false);
  });

  it("clears pending and shows the error when the read fails, then allows a retry", async () => {
    vi.mocked(fetchAccountSecurity).mockRejectedValueOnce(new Error("offline"));
    await act(() => deletion.request());
    expect(deletion.pending).toBe(false);
    expect(deletion.error).toBeTruthy();
    expect(promptAccountDeletion).not.toHaveBeenCalled();
    await act(() => deletion.request());
    expect(fetchAccountSecurity).toHaveBeenCalledTimes(2);
    expect(container.querySelectorAll("section")).toHaveLength(1);
  });
});
