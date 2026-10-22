// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { authClient } from "../lib/auth";
import type { AuthCapabilities } from "../lib/auth-capabilities";
import { fetchAuthCapabilities } from "../lib/auth-capabilities";
import { AuthPage } from "./Auth";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray | { message: string }, ...values: unknown[]) =>
      "message" in strings
        ? strings.message
        : strings.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    children,
    variant,
    size,
    ...props
  }: React.ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button data-variant={variant ?? "default"} data-size={size} {...props}>
      {children}
    </button>
  ),
  Input: (props: React.ComponentProps<"input">) => <input {...props} />,
  InputOTP: ({
    maxLength,
    onChange,
    onComplete,
    children: _children,
    ...props
  }: Omit<React.ComponentProps<"input">, "onChange"> & {
    onChange: (value: string) => void;
    onComplete?: (value: string) => void;
  }) => (
    <input
      {...props}
      data-otp=""
      onChange={(event) => {
        onChange(event.target.value);
        if (event.target.value.length === maxLength) onComplete?.(event.target.value);
      }}
    />
  ),
  InputOTPGroup: () => null,
  InputOTPSlot: () => null,
  Label: ({ children, htmlFor, ...props }: React.ComponentProps<"label">) => (
    <label htmlFor={htmlFor} {...props}>
      {children}
    </label>
  ),
}));
vi.mock("../lib/auth-capabilities", () => ({ fetchAuthCapabilities: vi.fn() }));
vi.mock("../lib/auth", () => ({
  authClient: {
    signIn: { social: vi.fn(async () => ({})), email: vi.fn(), emailOtp: vi.fn() },
    emailOtp: { sendVerificationOtp: vi.fn() },
  },
}));
vi.mock("../lib/rpc", () => ({ clearSpaceSelection: vi.fn() }));
const capabilities: AuthCapabilities = {
  passwordAuth: false,
  sso: { name: "Example", availability: "unavailable" },
  passwordReset: false,
  resetUrl: null,
};
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  delete window.rakazoDesktop;
});
async function render(mode: "in" | "up" | "forgot" = "in") {
  await act(async () =>
    root.render(
      <MemoryRouter>
        <Routes>
          <Route path="/" element={<AuthPage mode={mode} />} />
          <Route path="/app" element={<p>App</p>} />
          <Route path="/onboarding" element={<p>Onboarding</p>} />
        </Routes>
      </MemoryRouter>,
    ),
  );
}
async function enter(input: Element | null, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function button(text: string) {
  return [...host.querySelectorAll("button")].find((button) => button.textContent === text)!;
}
async function submit() {
  await act(async () => {
    host.querySelector("form")!.requestSubmit();
  });
}
it("shows no credential form while capabilities load", async () => {
  vi.mocked(fetchAuthCapabilities).mockReturnValue(new Promise(() => undefined));
  await render();
  expect(host.querySelector("input")).toBeNull();
  expect(host.textContent).toContain("Loading…");
});
it.each(["in", "up"] as const)("offers SSO and hides credentials on %s", async (mode) => {
  vi.mocked(fetchAuthCapabilities).mockResolvedValue(capabilities);
  await render(mode);
  expect(host.textContent).toContain("Continue with Example");
  expect(host.querySelector("input")).toBeNull();
  const sso = host.querySelector("button")!;
  expect(sso.dataset.variant).toBe("default");
  expect(sso.className).toContain("w-full");
});
it("retries failed capabilities without exposing a password form", async () => {
  vi.mocked(fetchAuthCapabilities)
    .mockRejectedValueOnce(new Error())
    .mockResolvedValueOnce(capabilities);
  await render();
  expect(host.textContent).toContain("Could not load sign-in options");
  expect(host.querySelector("input")).toBeNull();
  const retry = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Retry",
  )!;
  await act(async () => retry.click());
  expect(fetchAuthCapabilities).toHaveBeenCalledTimes(2);
  expect(host.textContent).toContain("Continue with Example");
});
it.each(["in", "up"] as const)("puts quiet SSO below the primary action on %s", async (mode) => {
  vi.mocked(fetchAuthCapabilities).mockResolvedValue({ ...capabilities, passwordAuth: true });
  await render(mode);
  const email = host.querySelector('input[name="email"]')!;
  const password = host.querySelector('input[type="password"]')!;
  const submit = host.querySelector('button[type="submit"]')!;
  const sso = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Continue with Example",
  )!;
  for (const [first, second] of [
    [email, password],
    [password, submit],
    [submit, sso],
  ] as const) {
    expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  }
  expect(submit.getAttribute("data-variant")).toBe("default");
  expect(sso.dataset.variant).toBe("link");
  expect(sso.dataset.size).toBe("sm");
});

it("hides SSO in password recovery", async () => {
  vi.mocked(fetchAuthCapabilities).mockResolvedValue({ ...capabilities, passwordAuth: true });
  await render("forgot");
  expect(host.textContent).not.toContain("Continue with Example");
});

it("selects a non-redirecting SSO request on desktop", async () => {
  vi.spyOn(window, "open").mockReturnValue({ close: vi.fn() } as unknown as Window);
  window.rakazoDesktop = {} as NonNullable<Window["rakazoDesktop"]>;
  vi.mocked(fetchAuthCapabilities).mockResolvedValue(capabilities);
  vi.mocked(authClient.signIn.social).mockResolvedValue({
    data: null,
    error: { message: "Unavailable", status: 503, statusText: "Unavailable" },
  });
  await render();
  const button = Array.from(host.querySelectorAll("button")).find((button) =>
    button.textContent?.includes("Continue with"),
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
  expect(authClient.signIn.social).toHaveBeenCalledWith(
    expect.objectContaining({ provider: "oidc", disableRedirect: true }),
  );
});

it("keeps SSO available for retry while an authorization request is pending", async () => {
  vi.mocked(fetchAuthCapabilities).mockResolvedValue(capabilities);
  vi.mocked(authClient.signIn.social).mockReturnValue(new Promise(() => undefined));
  await render();
  const button = Array.from(host.querySelectorAll("button")).find((button) =>
    button.textContent?.includes("Continue with"),
  )!;
  await act(async () => button.click());
  expect(button.disabled).toBe(false);
  await act(async () => button.click());
  expect(authClient.signIn.social).toHaveBeenCalledTimes(2);
});

const codeCapabilities: AuthCapabilities = {
  ...capabilities,
  sso: null,
  passwordAuth: true,
  emailCode: true,
};

it("signs in with an emailed code by default", async () => {
  vi.mocked(fetchAuthCapabilities).mockResolvedValue(codeCapabilities);
  vi.mocked(authClient.emailOtp.sendVerificationOtp).mockResolvedValue({
    data: { success: true },
    error: null,
  } as never);
  vi.mocked(authClient.signIn.emailOtp).mockResolvedValue({ data: {}, error: null } as never);
  await render();
  expect(host.querySelector('input[type="password"]')).toBeNull();
  await enter(host.querySelector('input[name="email"]'), " person@example.com ");
  expect(host.querySelector('button[type="submit"]')!.textContent).toBe("Continue");
  await submit();
  expect(authClient.emailOtp.sendVerificationOtp).toHaveBeenCalledWith({
    email: "person@example.com",
    type: "sign-in",
  });
  expect(host.querySelector("h1")!.textContent).toBe("Check your email");
  const code = host.querySelector('input[aria-label="Code"]')!;
  expect(code.getAttribute("autocomplete")).toBe("one-time-code");
  await enter(code, "123456");
  expect(authClient.signIn.emailOtp).toHaveBeenCalledWith({
    email: "person@example.com",
    otp: "123456",
    name: undefined,
  });
  expect(host.textContent).toBe("App");
});

it("names a new account and keeps the email when going back from the code", async () => {
  vi.mocked(fetchAuthCapabilities).mockResolvedValue(codeCapabilities);
  vi.mocked(authClient.emailOtp.sendVerificationOtp).mockResolvedValue({
    data: { success: true },
    error: null,
  } as never);
  vi.mocked(authClient.signIn.emailOtp)
    .mockResolvedValueOnce({
      data: null,
      error: { code: "INVALID_OTP", message: "Invalid OTP", status: 400, statusText: "" },
    } as never)
    .mockResolvedValueOnce({ data: {}, error: null } as never);
  await render("up");
  await enter(host.querySelector('input[name="name"]'), "Ada");
  await enter(host.querySelector('input[name="email"]'), "ada@example.com");
  await submit();
  await enter(host.querySelector('input[aria-label="Code"]'), "111111");
  expect(host.querySelector('[role="alert"]')!.textContent).toBe("Invalid code");
  await act(async () => button("Back").click());
  expect(host.querySelector<HTMLInputElement>('input[name="email"]')!.value).toBe(
    "ada@example.com",
  );
  await submit();
  expect(authClient.emailOtp.sendVerificationOtp).toHaveBeenCalledTimes(2);
  await enter(host.querySelector('input[aria-label="Code"]'), "222222");
  expect(authClient.signIn.emailOtp).toHaveBeenLastCalledWith({
    email: "ada@example.com",
    otp: "222222",
    name: "Ada",
  });
  expect(host.textContent).toBe("Onboarding");
});

it("sends the code on the first Continue but never submits an unfinished code", async () => {
  vi.mocked(fetchAuthCapabilities).mockResolvedValue(codeCapabilities);
  vi.mocked(authClient.emailOtp.sendVerificationOtp).mockResolvedValue({
    data: { success: true },
    error: null,
  } as never);
  await render();
  await enter(host.querySelector('input[name="email"]'), "person@example.com");
  expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
  await submit();
  expect(authClient.emailOtp.sendVerificationOtp).toHaveBeenCalledTimes(1);
  const continueButton = host.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  expect(continueButton.disabled).toBe(true);
  await submit();
  await enter(host.querySelector('input[aria-label="Code"]'), "12345");
  expect(continueButton.disabled).toBe(true);
  await submit();
  expect(authClient.signIn.emailOtp).not.toHaveBeenCalled();
  expect(authClient.emailOtp.sendVerificationOtp).toHaveBeenCalledTimes(1);
});

it("keeps password sign-in one step away", async () => {
  vi.mocked(fetchAuthCapabilities).mockResolvedValue(codeCapabilities);
  await render();
  await act(async () => button("Use password").click());
  expect(host.querySelector('input[type="password"]')).not.toBeNull();
  expect(host.querySelector('button[type="submit"]')!.textContent).toBe("Continue with email");
  await act(async () => button("Use email code").click());
  expect(host.querySelector('input[type="password"]')).toBeNull();
});

it("leaves the password form unchanged without email codes", async () => {
  vi.mocked(fetchAuthCapabilities).mockResolvedValue({ ...codeCapabilities, emailCode: false });
  await render();
  expect(host.querySelector('input[type="password"]')).not.toBeNull();
  expect(host.querySelector('button[type="submit"]')!.textContent).toBe("Continue with email");
  expect(host.textContent).not.toContain("Use email code");
  expect(host.textContent).not.toContain("Use password");
});
