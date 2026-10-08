// @vitest-environment jsdom
import { tokensForAppearance } from "@rakazo/ui-tokens";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SignIn from "../app/sign-in";
import { passwordResetCapabilities } from "./api";
import type { NativeActionButtonProps } from "./native-controls";

const route = vi.hoisted(() => ({ mode: "in" }));

vi.mock("expo-router", () => ({
  Redirect: () => null,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useLocalSearchParams: () => route,
  useFocusEffect: () => undefined,
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
      placeholder,
      secureTextEntry,
    }: {
      placeholder: string;
      secureTextEntry?: boolean;
    }) => <input aria-label={placeholder} type={secureTextEntry ? "password" : "text"} />,
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
  NativeActionButton: ({ label, prominence = "primary", onPress }: NativeActionButtonProps) => (
    <button type="button" data-prominence={prominence} onClick={onPress}>
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
  currentApiBase: () => "https://example.invalid",
  displayApiHost: () => "example.invalid",
  usesCustomApiBase: () => false,
  loadSessionToken: vi.fn().mockResolvedValue(null),
  passwordResetCapabilities: vi.fn(),
  requestPasswordReset: vi.fn(),
  rpc: vi.fn(),
  signIn: vi.fn(),
  signUp: vi.fn(),
}));
vi.mock("./sso", () => ({ continueWithSso: vi.fn() }));
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
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(passwordResetCapabilities).mockResolvedValue(capabilities);
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
