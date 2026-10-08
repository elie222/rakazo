// @vitest-environment jsdom
import type { AccountSecurity } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fetchAccountSecurity, requestAccountDeletionCode } from "../lib/account-security";
import { authClient } from "../lib/auth";
import { runSsoFlow } from "../lib/sso-flow";
import { AccountAccess } from "./AccountAccess";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({ variant: _variant, ...props }: ComponentProps<"button"> & { variant?: string }) => (
    <button {...props} />
  ),
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  Label: ({ htmlFor, children, ...props }: ComponentProps<"label">) => (
    <label htmlFor={htmlFor} {...props}>
      {children}
    </label>
  ),
}));
vi.mock("../lib/account-security", () => ({
  fetchAccountSecurity: vi.fn(),
  requestAccountDeletionCode: vi.fn(),
}));
vi.mock("../lib/auth", () => ({
  authClient: { linkSocial: vi.fn(), signIn: { social: vi.fn() }, deleteUser: vi.fn() },
}));
vi.mock("../lib/sso-flow", () => ({
  runSsoFlow: vi.fn(async (begin) => begin(true, (url: string) => `popup:${url}`)),
}));
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const security: AccountSecurity = {
  hasPassword: false,
  freshOidcAuth: false,
  ssoLinked: false,
  emailDeletion: false,
  sso: { name: "SSO" },
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchAccountSecurity).mockResolvedValue(security);
  vi.mocked(authClient.linkSocial).mockResolvedValue({
    data: { url: "https://identity.example.test/authorize", redirect: true },
    error: null,
  });
  vi.mocked(authClient.signIn.social).mockResolvedValue({
    data: { url: "https://identity.example.test/authorize", redirect: true },
    error: null,
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
async function render() {
  await act(async () => root.render(<AccountAccess />));
}
async function click(label: string) {
  const button = Array.from(host.querySelectorAll("button")).find(
    (button) => button.textContent === label,
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
}
it("uses the shared desktop flow for linking", async () => {
  await render();
  await click("Link SSO");
  expect(runSsoFlow).toHaveBeenCalledWith(expect.any(Function), [window.location.href]);
  expect(authClient.linkSocial).toHaveBeenCalledWith(
    expect.objectContaining({
      provider: "oidc",
      disableRedirect: true,
      callbackURL: `popup:${window.location.href}`,
      errorCallbackURL: `popup:${window.location.href}`,
    }),
  );
});
it("uses the shared desktop flow for account-bound deletion reauthentication", async () => {
  await render();
  await click("Delete account");
  await click("Sign in again");
  expect(runSsoFlow).toHaveBeenCalledWith(expect.any(Function), [window.location.href]);
  expect(authClient.signIn.social).toHaveBeenCalledWith(
    expect.objectContaining({
      disableRedirect: true,
      additionalData: { reauthenticate: true },
      callbackURL: `popup:${window.location.href}`,
      errorCallbackURL: `popup:${window.location.href}`,
    }),
  );
});
it("shows the password deletion path for legacy account security", async () => {
  vi.mocked(fetchAccountSecurity).mockResolvedValue({ ...security, hasPassword: true, sso: null });
  await render();
  await click("Delete account");
  expect(host.querySelector('input[type="password"]')).not.toBeNull();
  expect(host.textContent).not.toContain("Link SSO");
  expect(host.textContent).not.toContain("Sign in again");
  expect(host.textContent).not.toContain("Send deletion code");
});

function deleteButton() {
  return Array.from(host.querySelectorAll("button")).filter(
    (button) => button.textContent === "Delete account",
  )[1]!;
}
it("disables passwordless deletion without a proof or nonempty code", async () => {
  await render();
  await click("Delete account");
  expect(deleteButton().disabled).toBe(true);
});
it("refreshes an expired proof before submitting and offers reauthentication", async () => {
  vi.mocked(fetchAccountSecurity)
    .mockResolvedValueOnce({ ...security, freshOidcAuth: true })
    .mockResolvedValue(security);
  await render();
  await click("Delete account");
  expect(deleteButton().disabled).toBe(false);
  await act(async () => deleteButton().click());
  expect(fetchAccountSecurity).toHaveBeenCalledTimes(2);
  expect(authClient.deleteUser).not.toHaveBeenCalled();
  expect(deleteButton().disabled).toBe(true);
  expect(host.textContent).toContain("Sign in again");
});
it("keeps account SSO actions available for retry", async () => {
  vi.mocked(runSsoFlow).mockReturnValue(new Promise(() => undefined));
  await render();
  await click("Link SSO");
  await click("Link SSO");
  expect(runSsoFlow).toHaveBeenCalledTimes(2);
  await click("Delete account");
  await click("Sign in again");
  await click("Sign in again");
  expect(runSsoFlow).toHaveBeenCalledTimes(4);
});

it("requires a nonempty code and allows it after the proof expires", async () => {
  vi.mocked(fetchAccountSecurity).mockResolvedValue({ ...security, emailDeletion: true });
  vi.mocked(requestAccountDeletionCode).mockResolvedValue(undefined);
  vi.mocked(authClient.deleteUser).mockResolvedValue({
    data: null,
    error: {
      code: "REAUTHENTICATION_REQUIRED",
      message: "Sign in again",
      status: 403,
      statusText: "Forbidden",
    },
  });
  await render();
  await click("Delete account");
  await click("Send deletion code");
  const input = host.querySelector<HTMLInputElement>("#deletion-code")!;
  async function enter(value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  await enter("   ");
  expect(deleteButton().disabled).toBe(true);
  await enter(" 123456 ");
  expect(deleteButton().disabled).toBe(false);
  await act(async () => deleteButton().click());
  expect(fetchAccountSecurity).toHaveBeenCalledTimes(2);
  expect(authClient.deleteUser).toHaveBeenCalledWith({ token: "123456" });
});
