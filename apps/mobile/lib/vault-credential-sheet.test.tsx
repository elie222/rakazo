// @vitest-environment jsdom

import { decodeLoginSecret, LOGIN_FIELD_LIMIT } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("react-native", () => {
  const View = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Modal: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    Platform: { OS: "ios" },
    View,
    ScrollView: View,
    Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
    TextInput: ({
      value,
      onChangeText,
      accessibilityLabel,
      secureTextEntry,
      textContentType,
    }: {
      value: string;
      onChangeText: (value: string) => void;
      accessibilityLabel: string;
      secureTextEntry?: boolean;
      textContentType?: string;
    }) => (
      <input
        type={secureTextEntry ? "password" : "text"}
        value={value}
        onChange={(event) => onChangeText(event.target.value)}
        aria-label={accessibilityLabel}
        data-content-type={textContentType}
      />
    ),
    StyleSheet: { create: <T,>(styles: T) => styles },
  };
});
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("./appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("./native", () => ({ useThemedStyles: (factory: () => unknown) => factory() }));
vi.mock("./i18n", () => {
  const t = (text: string, values?: Record<string, string>) =>
    text.replace(/\{(\w+)\}/g, (_, key: string) => values?.[key] ?? key);
  return { t, useI18n: () => ({ t }) };
});
vi.mock("./user-error", () => ({ errorText: (_: unknown, fallback: string) => fallback }));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({
    label,
    accessibilityLabel,
    onPress,
    disabled,
  }: {
    label?: string;
    accessibilityLabel?: string;
    onPress: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" onClick={onPress} disabled={disabled}>
      {label ?? accessibilityLabel}
    </button>
  ),
}));
vi.mock("../components/native-switch", () => ({
  NativeSwitch: ({
    value,
    onValueChange,
    accessibilityLabel,
  }: {
    value: boolean;
    onValueChange: (next: boolean) => void;
    accessibilityLabel: string;
  }) => (
    <input
      type="checkbox"
      checked={value}
      onChange={(event) => onValueChange(event.target.checked)}
      aria-label={accessibilityLabel}
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
    onChange: (key: string) => void;
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

import { VaultCredentialSheet } from "../components/vault-credential-sheet";

const onClose = vi.fn();
const onSave = vi.fn<(destination: unknown, value: string) => Promise<void>>();
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const field = (label: string) =>
  container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
const save = () =>
  [...container.querySelectorAll("button")].find((node) => node.textContent === "Save")!;

async function typeInto(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const type = (label: string, value: string) => typeInto(field(label)!, value);

async function choose(type: string) {
  await act(async () => {
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="Type"]')!;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, type);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function render(replacing: Parameters<typeof VaultCredentialSheet>[0]["replacing"] = null) {
  await act(async () =>
    root.render(<VaultCredentialSheet replacing={replacing} onClose={onClose} onSave={onSave} />),
  );
}

it("adds a command variable without a site, then clears the value", async () => {
  onSave.mockResolvedValue();
  await render();
  expect(container.textContent).toContain("Add credential");
  await type("Name", "NetBird-Key");
  expect(field("Name")!.value).toBe("netbird-key");
  await choose("command");
  expect(field("Site")).toBeNull();
  expect(save().disabled).toBe(true);
  await type("Value", "example-value");
  expect(field("Value")!.type).toBe("password");
  expect(save().disabled).toBe(false);

  await act(async () => save().click());
  expect(onSave).toHaveBeenCalledWith(
    { name: "netbird-key", auth: { type: "command" } },
    "example-value",
  );
  expect(field("Value")!.value).toBe("");
});

it("asks for another name when a command variable is reserved", async () => {
  await render();
  await type("Name", "path");
  await choose("command");
  expect(container.textContent).toContain("$PATH is reserved. Choose another name.");
  await type("Value", "example-value");
  expect(save().disabled).toBe(true);
});

it("explains a name that cannot be saved", async () => {
  await render();
  await type("Name", "my key");
  expect(container.textContent).toContain(
    "Use lowercase letters, numbers, - and _, starting with a letter.",
  );
});

const savedLogin = {
  name: "example-login",
  origin: "https://login.example.test",
  auth: { type: "login" as const },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const buttonNamed = (label: string) =>
  [...container.querySelectorAll("button")].filter((node) => node.textContent === label);
const labelFields = () => [
  ...container.querySelectorAll<HTMLInputElement>('input[aria-label="Label"]'),
];
const hiddenSwitches = () => [
  ...container.querySelectorAll<HTMLInputElement>('input[aria-label="Hidden"]'),
];

it("replaces a website login's fields on its saved site", async () => {
  onSave.mockResolvedValue();
  await render(savedLogin);
  expect(container.textContent).toContain("example-login");
  expect(container.textContent).toContain("login.example.test");
  expect(field("Name")).toBeNull();
  expect(labelFields().map((input) => input.value)).toEqual(["Username", "Password"]);
  expect(hiddenSwitches().map((input) => input.checked)).toEqual([false, true]);
  expect(field("Username")!.type).toBe("text");
  expect(field("Password")!.type).toBe("password");
  expect(field("Password")!.dataset.contentType).toBe("password");
  await type("Username", " ada ");
  await type("Password", "example-password");

  await act(async () => save().click());
  const [destination, value] = onSave.mock.lastCall!;
  expect(destination).toEqual({
    name: "example-login",
    origin: "https://login.example.test",
    auth: { type: "login" },
  });
  expect(decodeLoginSecret(value)).toEqual({
    fields: [
      { label: "Username", value: "ada", hidden: false },
      { label: "Password", value: "example-password", hidden: true },
    ],
  });
  expect(field("Username")!.value).toBe("");
  expect(field("Password")!.value).toBe("");
});

it("adds, names and removes login fields, saving only a complete login", async () => {
  onSave.mockResolvedValue();
  await render(savedLogin);
  await type("Username", "ada");
  await type("Password", "example-password");
  expect(save().disabled).toBe(false);

  await act(async () => buttonNamed("Add field")[0]!.click());
  expect(labelFields()).toHaveLength(3);
  expect(hiddenSwitches()[2]!.checked).toBe(true);
  expect(field("Value")!.type).toBe("password");
  expect(save().disabled).toBe(true);

  await type("Value", "1234");
  expect(save().disabled).toBe(true);
  await typeInto(labelFields()[2]!, " password ");
  expect(save().disabled).toBe(true);
  await typeInto(labelFields()[2]!, "PIN");
  expect(save().disabled).toBe(false);

  await act(async () => buttonNamed("Remove")[0]!.click());
  expect(labelFields().map((input) => input.value)).toEqual(["Password", "PIN"]);
  await act(async () => buttonNamed("Remove")[0]!.click());
  expect(buttonNamed("Remove")).toHaveLength(0);

  await act(async () => save().click());
  expect(decodeLoginSecret(onSave.mock.lastCall![1])).toEqual({
    fields: [{ label: "PIN", value: "1234", hidden: true }],
  });
});

it("stops offering Add field at the login field limit", async () => {
  await render(savedLogin);
  for (let count = 2; count < LOGIN_FIELD_LIMIT; count += 1) {
    await act(async () => buttonNamed("Add field")[0]!.click());
  }
  expect(labelFields()).toHaveLength(LOGIN_FIELD_LIMIT);
  expect(buttonNamed("Add field")).toHaveLength(0);
});

it("clears the value and shows an error when saving fails", async () => {
  onSave.mockRejectedValue(new Error("offline"));
  await render();
  await type("Name", "github");
  await type("Site", "https://api.github.com");
  await type("Value", "example-value");

  await act(async () => save().click());
  expect(container.textContent).toContain("Could not save the credential");
  expect(field("Value")!.value).toBe("");
  expect(field("Name")!.value).toBe("github");
  expect(onClose).not.toHaveBeenCalled();
});

it("stays open while a save is in flight, so a failure is still shown", async () => {
  let fail!: () => void;
  onSave.mockImplementation(
    () =>
      new Promise<void>((_, reject) => {
        fail = () => reject(new Error("offline"));
      }),
  );
  await render();
  await type("Name", "github");
  await type("Site", "https://api.github.com");
  await type("Value", "example-value");
  await act(async () => save().click());
  const cancel = () =>
    [...container.querySelectorAll("button")].find((node) => node.textContent === "Cancel")!;
  expect(cancel().disabled).toBe(true);

  await act(async () => fail());
  expect(container.textContent).toContain("Could not save the credential");
  expect(cancel().disabled).toBe(false);
});
