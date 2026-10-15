// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), alert: vi.fn(), openURL: vi.fn() }));
vi.mock("./api", () => ({ rpc: mocks.rpc }));
vi.mock("./i18n", () => {
  const t = (value: string, values?: Record<string, string>) =>
    value.replace(/\{(\w+)\}/g, (_, key) => values?.[key] ?? "");
  return { t, useI18n: () => ({ t }) };
});
vi.mock("./native", () => ({
  native: { fill: "transparent" },
  useMobileTokens: () => ({
    foreground: "black",
    mutedForeground: "gray",
    border: "gray",
    destructive: "red",
  }),
}));
vi.mock("react-native", () => ({
  Alert: { alert: mocks.alert },
  Linking: { openURL: mocks.openURL },
  View: ({ children, testID }: { children?: ReactNode; testID?: string }) => (
    <div data-testid={testID}>{children}</div>
  ),
  Text: ({ children, accessibilityRole }: { children?: ReactNode; accessibilityRole?: string }) => (
    <span role={accessibilityRole}>{children}</span>
  ),
  TextInput: ({
    accessibilityLabel,
    value,
    onChangeText,
    editable,
  }: {
    accessibilityLabel: string;
    value: string;
    onChangeText: (value: string) => void;
    editable?: boolean;
  }) => (
    <input
      aria-label={accessibilityLabel}
      value={value}
      onChange={(event) => onChangeText(event.target.value)}
      disabled={editable === false}
    />
  ),
}));
vi.mock("../components/menu-picker", () => ({
  MenuPicker: ({
    label,
    choices,
    value,
    onChange,
  }: {
    label: string;
    choices: { key: string; label: string }[];
    value: string;
    onChange: (value: string) => void;
  }) => (
    <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
      {choices.map((choice) => (
        <option key={choice.key} value={choice.key}>
          {choice.label}
        </option>
      ))}
    </select>
  ),
}));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({
    label,
    onPress,
    disabled,
  }: {
    label: string;
    onPress: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("../components/native-switch", () => ({
  NativeSwitch: ({
    accessibilityLabel,
    value,
    onValueChange,
  }: {
    accessibilityLabel: string;
    value: boolean;
    onValueChange: (value: boolean) => void;
  }) => (
    <input
      type="checkbox"
      aria-label={accessibilityLabel}
      checked={value}
      onChange={(event) => onValueChange(event.target.checked)}
    />
  ),
}));

import { NativeLoginSettings } from "../components/native-login-settings";

const pendingAccount = {
  credentialId: "native-account",
  harness: "kimi",
  label: "Personal",
  computerId: "computer-a",
  endpoint: "https://api.kimi.ai/coding/v1",
  state: {
    state: "pending",
    verificationUri: "https://www.kimi.com/device",
    userCode: "TEST-1234",
    expiresAt: null,
  },
};
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.rpc.mockImplementation(async (procedure: string) => {
    if (procedure === "nativeLogins/list")
      return {
        enabled: true,
        accounts: [],
        computers: [{ id: "computer-a", scope: "team", botName: null }],
      };
    if (procedure === "nativeLogins/begin") return pendingAccount;
    if (procedure === "nativeLogins/cancel")
      return { ...pendingAccount, state: { state: "failed", code: "cancelled" } };
    if (procedure === "nativeLogins/logout")
      return { ...pendingAccount, state: { state: "signed_out" } };
    throw new Error(`Unexpected ${procedure}`);
  });
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
  await act(async () => root.render(createElement(NativeLoginSettings)));
}
async function change(label: string, value: string) {
  await act(async () => {
    const field = container.querySelector<HTMLInputElement | HTMLSelectElement>(
      `[aria-label="${label}"]`,
    )!;
    const proto =
      field.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(field, value);
    field.dispatchEvent(
      new Event(field.tagName === "SELECT" ? "change" : "input", { bubbles: true }),
    );
  });
}
function button(label: string) {
  const value = [...container.querySelectorAll("button")].find(
    (entry) => entry.textContent === label,
  );
  if (!value) throw new Error(`Missing ${label}`);
  return value;
}
async function click(label: string) {
  await act(async () => button(label).click());
}
it("requires attestation before starting native Kimi sign-in", async () => {
  await render();
  await click("Native sign-in");
  await click("Add signed-in account");
  await change("Harness", "kimi");
  await change("Account name", "Personal");
  expect(button("Sign in").disabled).toBe(true);
  expect(container.textContent).toContain("Personal interactive chats only.");
  await act(async () =>
    container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
  );
  await click("Sign in");
  expect(mocks.rpc).toHaveBeenCalledWith("nativeLogins/begin", {
    harness: "kimi",
    label: "Personal",
    computerId: "computer-a",
    region: "global",
    selfHostedPersonalUse: true,
  });
  expect(container.textContent).toContain("TEST-1234");
  await click("Cancel sign-in");
  expect(mocks.rpc).toHaveBeenCalledWith("nativeLogins/cancel", { credentialId: "native-account" });
});
it("keeps native disconnect available when login is disabled", async () => {
  const base = mocks.rpc.getMockImplementation()!;
  mocks.rpc.mockImplementation((procedure: string, input?: unknown) =>
    procedure === "nativeLogins/list"
      ? Promise.resolve({
          enabled: false,
          accounts: [
            { ...pendingAccount, state: { state: "ready", accountLabel: null, plan: null } },
          ],
          computers: [],
        })
      : base(procedure, input),
  );
  await render();
  await click("Native sign-in");
  expect(container.textContent).not.toContain("Add signed-in account");
  await click("Disconnect");
  expect(mocks.alert.mock.lastCall?.[1]).toContain("Provider sessions may remain active");
  await act(async () => mocks.alert.mock.lastCall?.[2][1].onPress());
  expect(mocks.rpc).toHaveBeenCalledWith("nativeLogins/logout", { credentialId: "native-account" });
  expect(button("Reconnect").disabled).toBe(true);
});

it("allows cleanup of failed sign-ins while new logins are disabled", async () => {
  mocks.rpc.mockResolvedValue({
    enabled: false,
    accounts: [{ ...pendingAccount, state: { state: "failed", code: "expired" } }],
    computers: [],
  });
  await render();
  await click("Native sign-in");
  expect(button("Reconnect").disabled).toBe(true);
  expect(button("Disconnect").disabled).toBe(false);
});
