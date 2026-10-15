// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), alert: vi.fn(), announce: vi.fn() }));
vi.mock("../components/native-login-settings", () => ({ NativeLoginSettings: () => null }));
vi.mock("./api", () => ({
  rpc: mocks.rpc,
  selectedSpaceId: () => "space-test",
  captureApiRequestContext: async () => ({}),
}));
vi.mock("./i18n", () => {
  const t = (value: string, values?: Record<string, unknown>) =>
    value.replace(/\{(\w+)\}/g, (_, key) => String(values?.[key] ?? ""));
  return { useI18n: () => ({ t }) };
});
vi.mock("./appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("./model-auth", () => ({
  cancelModelOAuthAttempt: vi.fn(),
  finishModelOAuthAttempt: vi.fn(),
  waitForModelOAuth: vi.fn(),
}));
vi.mock("./native", () => ({
  native: {},
  useResolvedAppearance: () => "light",
  useThemedStyles: () => ({}),
}));
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn() }));
vi.mock("expo-router", async () => {
  const { useEffect } = await import("react");
  return { useFocusEffect: (callback: () => void) => useEffect(callback, [callback]) };
});
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  ScrollView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
    disabled,
  }: {
    children: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
    disabled?: boolean;
  }) => (
    <button type="button" aria-label={accessibilityLabel} onClick={onPress} disabled={disabled}>
      {children}
    </button>
  ),
  TextInput: ({
    value,
    onChangeText,
    accessibilityLabel,
    placeholder,
    secureTextEntry,
  }: {
    value: string;
    onChangeText: (value: string) => void;
    accessibilityLabel?: string;
    placeholder?: string;
    secureTextEntry?: boolean;
  }) => (
    <input
      aria-label={accessibilityLabel}
      type={secureTextEntry ? "password" : "text"}
      value={value}
      placeholder={placeholder}
      onChange={(event) => onChangeText(event.target.value)}
    />
  ),
  ActivityIndicator: () => <span>Loading</span>,
  Alert: { alert: mocks.alert },
  Keyboard: { dismiss: vi.fn() },
  Linking: { openURL: vi.fn() },
  AccessibilityInfo: { announceForAccessibility: mocks.announce },
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 },
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
vi.mock("../components/native-switch", () => ({ NativeSwitch: () => null }));
vi.mock("../components/row-accessories", () => ({ Checkmark: () => null, Chevron: () => null }));
vi.mock("./message-action-sheet", () => ({ presentMessageActionSheet: vi.fn() }));

import Models from "../app/(settings)/models";

const accountOne = {
  id: "account-one",
  provider: "deepseek",
  label: "Team",
  hasKey: true,
  isDefault: true,
  authKind: "api_key",
  modelId: "deepseek-chat",
};
const accountTwo = { ...accountOne, id: "account-two", label: "Project", isDefault: false };
let credentials = [accountOne, accountTwo];
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  credentials = [accountOne, accountTwo];
  mocks.rpc.mockImplementation(async (procedure: string, input?: Record<string, unknown>) => {
    if (procedure === "me")
      return {
        userId: "user-test",
        spaceId: "space-test",
        defaultProvider: "deepseek",
        defaultModel: "deepseek-chat",
      };
    if (procedure === "models/list")
      return [
        {
          provider: "deepseek",
          providerName: "DeepSeek",
          id: "deepseek-chat",
          label: "DeepSeek Chat",
          auth: "api-key",
          authHint: "API key",
        },
      ];
    if (procedure === "models/credentials") return credentials;
    if (procedure === "models/backups") return [];
    if (procedure === "models/connect") {
      const previous = credentials.find((entry) => entry.id === input?.credentialId);
      const saved = {
        ...(previous ?? accountTwo),
        id: previous?.id ?? "account-new",
        label: String(input?.label ?? "New"),
      };
      credentials = [...credentials.filter((entry) => entry.id !== saved.id), saved];
      return saved;
    }
    if (procedure === "models/disconnect" || procedure === "models/setDefault") return { ok: true };
    throw new Error(`Unexpected ${procedure}`);
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () => root.render(<Models />));
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
async function click(label: string) {
  await act(async () => {
    const button = [...container.querySelectorAll("button")].find(
      (entry) => entry.textContent === label,
    );
    if (!button) throw new Error(`Missing ${label}`);
    button.click();
  });
}
it("renames and selects an exact same-provider account", async () => {
  await render();
  await change("Account", "account-two");
  await change("Account name", "Review");
  await click("Rename");
  expect(mocks.rpc).toHaveBeenCalledWith("models/connect", {
    provider: "deepseek",
    credentialId: "account-two",
    label: "Review",
    makeDefault: false,
  });
  await click("Use this model");
  expect(mocks.rpc).toHaveBeenCalledWith(
    "models/setDefault",
    expect.objectContaining({ credentialId: "account-two", modelId: "deepseek-chat" }),
  );
});
it("creates a separate account without using the old account or changing the default", async () => {
  await render();
  await change("Account", "new");
  await change("Account name", "New project");
  const key = container.querySelector<HTMLInputElement>('input[type="password"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      key,
      "sk-fake-project-key",
    );
    key.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("Connect API key");
  const input = mocks.rpc.mock.calls.find(([procedure]) => procedure === "models/connect")?.[1];
  expect(input).toMatchObject({ createNew: true, makeDefault: false, label: "New project" });
  expect(input).not.toHaveProperty("credentialId");
  expect(container.querySelector<HTMLSelectElement>('[aria-label="Account"]')!.value).toBe(
    "account-new",
  );
});
it("disconnects only the account confirmed in the native alert", async () => {
  await render();
  await change("Account", "account-two");
  await click("Disconnect");
  expect(mocks.alert.mock.lastCall?.[0]).toBe("Disconnect Project?");
  await act(async () => mocks.alert.mock.lastCall?.[2][1].onPress());
  expect(mocks.rpc).toHaveBeenCalledWith("models/disconnect", {
    provider: "deepseek",
    credentialId: "account-two",
  });
});

it("reconnects a secondary account without claiming it became the default", async () => {
  await render();
  await change("Account", "account-two");
  const key = container.querySelector<HTMLInputElement>('input[type="password"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      key,
      "sk-fake-replacement",
    );
    key.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("Replace API key");
  expect(mocks.rpc).toHaveBeenCalledWith(
    "models/connect",
    expect.objectContaining({ credentialId: "account-two", makeDefault: false }),
  );
  expect(mocks.announce).toHaveBeenLastCalledWith("Saved.");
});
