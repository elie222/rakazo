// @vitest-environment jsdom

import type { AccountSecurity } from "@rakazo/contracts";
import { tokensForAppearance } from "@rakazo/ui-tokens";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { Platform } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAccountDeletion } from "../components/account-deletion";
import { deleteAccount, fetchAccountSecurity, requestAccountDeletionCode } from "./api-auth";
import { replaceWithSignIn } from "./auth-routing";
import { forgetSignedIn } from "./returning-user";
import { continueWithSso } from "./sso";

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
vi.mock("../components/native-action-button", () => ({
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
vi.mock("./api-auth", () => ({
  fetchAccountSecurity: vi.fn(),
  deleteAccount: vi.fn(),
  requestAccountDeletionCode: vi.fn(),
}));
vi.mock("./appearance", () => ({ mobileTokens: () => tokensForAppearance(appearance.current) }));
vi.mock("./native", () => ({
  native: {},
  useThemedStyles: (factory: () => unknown) => factory(),
}));
vi.mock("./auth-routing", () => ({ replaceWithSignIn: vi.fn() }));
vi.mock("./delete-account-prompt", () => ({ promptAccountDeletion: vi.fn(() => false) }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 34 }) }));
vi.mock("./returning-user", () => ({ forgetSignedIn: vi.fn() }));
vi.mock("./sso", () => ({ continueWithSso: vi.fn() }));

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
    let fail!: (error: Error) => void;
    vi.mocked(deleteAccount).mockReturnValue(
      new Promise((_, reject) => {
        fail = reject;
      }) as never,
    );
    await open();
    await click("Sign in again");
    vi.mocked(fetchAccountSecurity).mockResolvedValue({ ...passwordless, freshOidcAuth: true });
    await click("Delete");
    expect(container.querySelector("section")!.dataset.swipe).toBe("false");
    await act(async () => fail(new Error("offline")));
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
});
