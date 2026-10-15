// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  list: vi.fn(),
  begin: vi.fn(),
  status: vi.fn(),
  cancel: vi.fn(),
  logout: vi.fn(),
}));
vi.mock("../lib/rpc", () => ({ rpc: { nativeLogins: native } }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => `${text}${index ? values[index - 1] : ""}${part}`, ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => {
  const Pass = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  const Button = ({ children, onClick, disabled }: ComponentProps<"button">) => (
    <button type="button" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
  return {
    Button,
    Input: (props: ComponentProps<"input">) => <input {...props} />,
    NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
    NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
    Switch: ({
      checked,
      onCheckedChange,
      ...props
    }: Omit<ComponentProps<"input">, "onChange"> & {
      onCheckedChange: (checked: boolean) => void;
    }) => (
      <input
        {...props}
        type="checkbox"
        checked={checked}
        onChange={(event) => onCheckedChange(event.target.checked)}
      />
    ),
    AlertDialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
      open ? <div>{children}</div> : null,
    AlertDialogContent: Pass,
    AlertDialogHeader: Pass,
    AlertDialogTitle: Pass,
    AlertDialogDescription: Pass,
    AlertDialogFooter: Pass,
    AlertDialogAction: Button,
    AlertDialogCancel: Button,
  };
});

import { NativeLoginSettings } from "./NativeLoginSettings";

const pendingAccount = {
  credentialId: "native-account",
  harness: "codex",
  label: "Personal",
  computerId: "computer-a",
  endpoint: "https://chatgpt.com/backend-api/codex",
  state: {
    state: "pending",
    verificationUri: "https://auth.openai.com/codex/device",
    userCode: "TEST-1234",
    expiresAt: null,
  },
};
const readyAccount = {
  ...pendingAccount,
  state: { state: "ready", accountLabel: "Personal account", plan: null },
};
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  native.list.mockResolvedValue({
    enabled: true,
    accounts: [],
    computers: [{ id: "computer-a", scope: "team", botName: null }],
  });
  native.begin.mockResolvedValue(pendingAccount);
  native.status.mockResolvedValue(readyAccount);
  native.cancel.mockResolvedValue({
    ...pendingAccount,
    state: { state: "failed", code: "cancelled" },
  });
  native.logout.mockResolvedValue({ ...readyAccount, state: { state: "signed_out" } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () => root.render(<NativeLoginSettings />));
}
function button(text: string) {
  const item = [...container.querySelectorAll("button")].find(
    (entry) => entry.textContent === text,
  );
  if (!item) throw new Error(`Missing ${text}`);
  return item;
}
async function click(text: string) {
  await act(async () => button(text).click());
}
async function name(value: string) {
  await act(async () => {
    const field = container.querySelector<HTMLInputElement>('[id$="-name"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
it("does not offer sign-in on an ineligible deployment", async () => {
  native.list.mockResolvedValue({ enabled: false, accounts: [], computers: [] });
  await render();
  expect(container.textContent).toBe("");
  expect(native.begin).not.toHaveBeenCalled();
});
it("requires explicit personal-deployment attestation and displays only official user verification", async () => {
  vi.useFakeTimers();
  await render();
  await click("Add signed-in account");
  await name("Personal");
  expect(button("Sign in").disabled).toBe(true);
  await act(async () =>
    container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
  );
  await click("Sign in");
  expect(native.begin).toHaveBeenCalledWith({
    harness: "codex",
    label: "Personal",
    computerId: "computer-a",
    region: "global",
    selfHostedPersonalUse: true,
  });
  expect(container.querySelector("a")?.href).toBe("https://auth.openai.com/codex/device");
  expect(container.textContent).toContain("TEST-1234");
  expect(container.querySelector('input[type="password"]')).toBeNull();
  await click("Cancel sign-in");
  await act(async () => vi.advanceTimersByTimeAsync(9_000));
  expect(native.cancel).toHaveBeenCalledWith({ credentialId: "native-account" });
  expect(native.status).not.toHaveBeenCalled();
});
it("keeps local disconnect available after the operator disables login", async () => {
  native.list.mockResolvedValue({ enabled: false, accounts: [readyAccount], computers: [] });
  await render();
  expect(container.textContent).not.toContain("Add signed-in account");
  await click("Disconnect");
  expect(container.textContent).toContain("Provider sessions may remain active");
  await act(async () =>
    [...container.querySelectorAll("button")]
      .filter((entry) => entry.textContent === "Disconnect")
      .at(-1)!
      .click(),
  );
  expect(native.logout).toHaveBeenCalledWith({ credentialId: "native-account" });
  expect(button("Reconnect").disabled).toBe(true);
});
it("does not link an unexpected verification host", async () => {
  native.list.mockResolvedValue({
    enabled: true,
    accounts: [
      {
        ...pendingAccount,
        state: { ...pendingAccount.state, verificationUri: "https://evil.example.test/verify" },
      },
    ],
    computers: [],
  });
  await render();
  expect(container.querySelector("a")).toBeNull();
  expect(container.textContent).toContain("Sign-in page unavailable");
});
it("updates only the pending account when polling completes", async () => {
  vi.useFakeTimers();
  native.list.mockResolvedValue({ enabled: true, accounts: [pendingAccount], computers: [] });
  await render();
  await act(async () => vi.advanceTimersByTimeAsync(3_000));
  expect(container.textContent).toContain("Personal account");
  expect(container.textContent).not.toContain("TEST-1234");
  expect(vi.getTimerCount()).toBe(0);
});

it("allows cleanup of failed sign-ins while new logins are disabled", async () => {
  native.list.mockResolvedValue({
    enabled: false,
    accounts: [{ ...pendingAccount, state: { state: "failed", code: "expired" } }],
    computers: [],
  });
  await render();
  expect(button("Reconnect").disabled).toBe(true);
  expect(button("Disconnect").disabled).toBe(false);
});
