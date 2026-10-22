// @vitest-environment jsdom
import { tokensForAppearance } from "@rakazo/ui-tokens";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SignIn from "../app/sign-in";
import { passwordResetCapabilities, rpc, sendSignInCode, signInWithCode } from "./api";
import type { NativeActionButtonProps } from "./native-controls";
import { passkeysAvailable, signInWithPasskey } from "./passkey";

const route = vi.hoisted(() => ({ mode: "in" }));
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
const server = vi.hoisted(() => ({ base: "https://example.invalid", refocus: () => {} }));

vi.mock("expo-router", () => ({
  Redirect: () => null,
  useRouter: () => router,
  useLocalSearchParams: () => route,
  useFocusEffect: (effect: () => void) => {
    server.refocus = effect;
  },
}));
vi.mock("react-native", () => {
  const Container = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return {
    Platform: { OS: "ios" },
    Keyboard: { dismiss: vi.fn() },
    AccessibilityInfo: { announceForAccessibility: vi.fn() },
    KeyboardAvoidingView: Container,
    TouchableWithoutFeedback: Container,
    View: Container,
    ScrollView: Container,
    Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
    TextInput: ({
      accessibilityLabel,
      placeholder,
      secureTextEntry,
      textContentType,
      autoComplete,
      keyboardType,
      maxLength,
      value,
      onChangeText,
      onSubmitEditing,
    }: {
      accessibilityLabel?: string;
      placeholder: string;
      secureTextEntry?: boolean;
      textContentType?: string;
      autoComplete?: string;
      keyboardType?: string;
      maxLength?: number;
      value?: string;
      onChangeText?: (value: string) => void;
      onSubmitEditing?: () => void;
    }) => (
      <input
        aria-label={accessibilityLabel ?? placeholder}
        type={secureTextEntry ? "password" : "text"}
        data-text-content-type={textContentType}
        autoComplete={autoComplete}
        inputMode={keyboardType === "number-pad" ? "numeric" : undefined}
        maxLength={maxLength}
        value={value}
        onChange={(event) => onChangeText?.(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") onSubmitEditing?.();
        }}
      />
    ),
    Pressable: ({ children, onPress }: { children: ReactNode; onPress: () => void }) => (
      <button type="button" onClick={onPress}>
        {children}
      </button>
    ),
  };
});
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({
    label,
    prominence = "primary",
    onPress,
    disabled,
  }: NativeActionButtonProps) => (
    <button type="button" data-prominence={prominence} disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("./native", () => ({ useMobileTokens: () => tokensForAppearance("light") }));
vi.mock("./i18n", () => ({
  useI18n: () => ({
    t: (text: string, values?: Record<string, string>) =>
      text.replace(/\{(\w+)\}/g, (_, key: string) => values?.[key] ?? key),
  }),
}));
vi.mock("./api", () => ({
  currentApiBase: () => server.base,
  displayApiHost: () => "example.invalid",
  usesCustomApiBase: () => false,
  loadSessionToken: vi.fn().mockResolvedValue(null),
  passwordResetCapabilities: vi.fn(),
  requestPasswordReset: vi.fn(),
  rpc: vi.fn(),
  sendSignInCode: vi.fn(),
  signIn: vi.fn(),
  signInWithCode: vi.fn(),
  signUp: vi.fn(),
}));
vi.mock("./sso", () => ({ continueWithSso: vi.fn() }));
vi.mock("./passkey", () => ({ passkeysAvailable: vi.fn(), signInWithPasskey: vi.fn() }));
vi.mock("./user-error", () => ({ credentialIssueText: vi.fn(), errorText: vi.fn() }));

const capabilities = {
  passwordAuth: true,
  passwordReset: true,
  resetUrl: "https://example.invalid/reset-password",
  sso: { name: "Example", availability: "available" as const },
};
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  route.mode = "in";
  server.base = "https://example.invalid";
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(passwordResetCapabilities).mockResolvedValue(capabilities);
  vi.mocked(passkeysAvailable).mockReset().mockResolvedValue(false);
  vi.mocked(signInWithPasskey).mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () => root.render(<SignIn />));
}
function ssoButtons() {
  return [...host.querySelectorAll("button")].filter(
    (button) => button.textContent === "Continue with Example",
  );
}
function button(label: string) {
  return [...host.querySelectorAll("button")].find((button) => button.textContent === label);
}
function input(label: string) {
  return host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
}
async function type(field: HTMLInputElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function press(label: string) {
  await act(async () => button(label)!.click());
}
function expectBefore(first: Element, second: Element) {
  expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
}

it.each(["in", "up"])(
  "places a single quiet SSO action below the password form in %s mode",
  async (mode) => {
    route.mode = mode;
    await render();
    const email = host.querySelector('input[aria-label="Email"]')!;
    const password = host.querySelector('input[type="password"]')!;
    const submit = host.querySelector('button[data-prominence="primary"]')!;
    const buttons = ssoButtons();
    expect(buttons).toHaveLength(1);
    const sso = buttons[0]!;
    const prompt = [...host.querySelectorAll("span")].find(
      (span) =>
        span.textContent ===
        (mode === "in" ? "Don’t have an account?" : "Already have an account?"),
    )!;
    expect(submit.textContent).toBe(mode === "in" ? "Sign in" : "Sign up");
    expect(sso.dataset.prominence).toBe("quiet");
    expectBefore(email, password);
    expectBefore(password, submit);
    expectBefore(submit, sso);
    expectBefore(sso, prompt);
  },
);

it.each(["in", "up"])(
  "shows one primary SSO action without credentials in SSO-only %s mode",
  async (mode) => {
    route.mode = mode;
    vi.mocked(passwordResetCapabilities).mockResolvedValue({
      ...capabilities,
      passwordAuth: false,
    });
    await render();
    expect(ssoButtons()).toHaveLength(1);
    expect(ssoButtons()[0]!.dataset.prominence).toBe("primary");
    expect(host.querySelector('button[data-prominence="quiet"]')).toBeNull();
    expect(host.querySelector("input")).toBeNull();
  },
);

it("hides SSO when switching to password recovery", async () => {
  await render();
  const forgot = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Forgot password?",
  )!;
  act(() => forgot.click());
  expect(ssoButtons()).toHaveLength(0);
  expect(host.querySelector('input[type="password"]')).toBeNull();
  expect(host.querySelector('button[data-prominence="primary"]')?.textContent).toBe(
    "Send reset link",
  );
});

it("drops the code step when the server changes", async () => {
  vi.mocked(passwordResetCapabilities).mockResolvedValue({ ...capabilities, emailCode: true });
  vi.mocked(sendSignInCode).mockResolvedValue();
  await render();
  await type(input("Email")!, "ada@example.test");
  await press("Continue");
  expect(input("Code")).not.toBeNull();

  server.base = "https://other.invalid";
  await act(async () => server.refocus());
  expect(input("Code")).toBeNull();
  expect(button("Continue")).toBeDefined();
});

it("ignores a code sent by the previous server", async () => {
  vi.mocked(passwordResetCapabilities).mockResolvedValue({ ...capabilities, emailCode: true });
  vi.mocked(sendSignInCode).mockImplementation(async () => {
    server.base = "https://other.invalid";
  });
  await render();
  await type(input("Email")!, "ada@example.test");
  await press("Continue");
  expect(input("Code")).toBeNull();
});

it.each(["in", "up"])("signs in with an emailed code by default in %s mode", async (mode) => {
  route.mode = mode;
  vi.mocked(passwordResetCapabilities).mockResolvedValue({ ...capabilities, emailCode: true });
  vi.mocked(sendSignInCode).mockResolvedValue();
  vi.mocked(signInWithCode).mockResolvedValue();
  vi.mocked(rpc).mockResolvedValue({ needsSetup: false });
  await render();
  expect(host.querySelector('input[type="password"]')).toBeNull();
  expect(button("Forgot password?")).toBeUndefined();
  expect(button("Use password")!.dataset.prominence).toBe("quiet");
  if (mode === "up") await type(input("Name")!, "Ada");
  await type(input("Email")!, " ada@example.test ");
  await press("Continue");
  expect(sendSignInCode).toHaveBeenCalledWith("ada@example.test");
  expect(host.textContent).toContain("Check your email");

  const code = input("Code")!;
  expect(code.dataset.textContentType).toBe("oneTimeCode");
  expect(code.autocomplete).toBe("one-time-code");
  expect(code.inputMode).toBe("numeric");
  expect(code.maxLength).toBe(6);
  await type(code, "123 45");
  expect(signInWithCode).not.toHaveBeenCalled();
  await type(code, "123456");
  expect(signInWithCode).toHaveBeenCalledOnce();
  expect(signInWithCode).toHaveBeenCalledWith(
    "ada@example.test",
    "123456",
    mode === "up" ? "Ada" : undefined,
  );
  expect(router.replace).toHaveBeenCalledWith("/");
});

it("returns from the code step with the email kept", async () => {
  vi.mocked(passwordResetCapabilities).mockResolvedValue({ ...capabilities, emailCode: true });
  vi.mocked(sendSignInCode).mockResolvedValue();
  await render();
  await type(input("Email")!, "ada@example.test");
  await press("Continue");
  await press("Back");
  expect(input("Code")).toBeNull();
  expect(input("Email")!.value).toBe("ada@example.test");
  await press("Continue");
  expect(sendSignInCode).toHaveBeenCalledTimes(2);
});

it("reveals the password form behind Use password and returns to the code", async () => {
  vi.mocked(passwordResetCapabilities).mockResolvedValue({ ...capabilities, emailCode: true });
  await render();
  await press("Use password");
  expect(host.querySelector('input[type="password"]')).not.toBeNull();
  expect(host.querySelector('button[data-prominence="primary"]')?.textContent).toBe("Sign in");
  expect(button("Forgot password?")).toBeDefined();
  await press("Use email code");
  expect(host.querySelector('input[type="password"]')).toBeNull();
  expect(host.querySelector('button[data-prominence="primary"]')?.textContent).toBe("Continue");
});

it("keeps the password form without code sign-in", async () => {
  await render();
  expect(host.querySelector('input[type="password"]')).not.toBeNull();
  expect(button("Use password")).toBeUndefined();
  expect(button("Use email code")).toBeUndefined();
});

it("sends the code on the first Continue but never submits an unfinished code", async () => {
  vi.mocked(passwordResetCapabilities).mockResolvedValue({ ...capabilities, emailCode: true });
  await render();
  await type(input("Email")!, "ada@example.test");
  expect(button("Continue")!.disabled).toBe(false);
  await press("Continue");
  expect(sendSignInCode).toHaveBeenCalledTimes(1);
  const code = input("Code")!;
  await type(code, "12345");
  expect(button("Continue")!.disabled).toBe(true);
  await act(async () => {
    code.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  expect(signInWithCode).not.toHaveBeenCalled();
  expect(sendSignInCode).toHaveBeenCalledTimes(1);
});

it("opens integration setup after a code sign-in from the sign-in form", async () => {
  vi.mocked(passwordResetCapabilities).mockResolvedValue({ ...capabilities, emailCode: true });
  vi.mocked(rpc).mockResolvedValue({ needsSetup: true });
  await render();
  await type(input("Email")!, "ada@example.test");
  await press("Continue");
  await type(input("Code")!, "123456");
  expect(signInWithCode).toHaveBeenCalledWith("ada@example.test", "123456", undefined);
  expect(rpc).toHaveBeenCalledWith("integrationSetup/get");
  expect(router.replace).toHaveBeenCalledWith("/integration-setup");
});

function buttonNamed(label: string) {
  return [...host.querySelectorAll("button")].find((button) => button.textContent === label);
}

it("offers a quiet passkey sign-in only in sign-in mode on a supported server", async () => {
  vi.mocked(passwordResetCapabilities).mockResolvedValue({
    ...capabilities,
    passkeyRpId: "example.invalid",
  });
  vi.mocked(passkeysAvailable).mockResolvedValue(true);
  vi.mocked(signInWithPasskey).mockResolvedValue(false);
  await render();
  const passkey = buttonNamed("Sign in with passkey")!;
  expect(passkeysAvailable).toHaveBeenLastCalledWith(
    expect.objectContaining({ passkeyRpId: "example.invalid" }),
  );
  expect(passkey.dataset.prominence).toBe("quiet");
  expectBefore(host.querySelector('button[data-prominence="primary"]')!, passkey);
  await act(async () => passkey.click());
  expect(signInWithPasskey).toHaveBeenCalledOnce();

  act(() => buttonNamed("Sign up")!.click());
  expect(buttonNamed("Sign in with passkey")).toBeUndefined();
});

it("hides passkey sign-in where the device or server cannot use it", async () => {
  await render();
  expect(buttonNamed("Sign in with passkey")).toBeUndefined();
});
