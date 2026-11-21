// @vitest-environment jsdom

import type { VaultRevealed } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resetI18nForTests } from "../../lib/i18n/i18n";
import type { VaultItem } from "../../lib/vault/vault";
import { VaultItemEditor } from "./vault-item-editor";

const { element } = vi.hoisted(() => ({
  element:
    (tag: string) =>
    ({ children }: { children?: ReactNode }) =>
      createElement(tag, null, children),
}));

vi.mock("../../lib/appearance/appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("../../lib/native/native", () => ({
  native: {},
  useThemedStyles: (factory: () => unknown) => factory(),
}));
vi.mock("react-native", () => ({
  Modal: element("div"),
  Platform: { OS: "ios" },
  ScrollView: element("div"),
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
  Text: element("span"),
  TextInput: ({
    accessibilityLabel,
    value,
    maxLength,
    onChangeText,
  }: {
    accessibilityLabel?: string;
    value?: string;
    maxLength?: number;
    onChangeText?: (text: string) => void;
  }) =>
    createElement("input", {
      "aria-label": accessibilityLabel,
      value,
      maxLength,
      onChange: (event: { target: { value: string } }) => onChangeText?.(event.target.value),
    }),
  View: element("div"),
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({}) }));
vi.mock("../native/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("../ui/menu-picker", () => ({ MenuPicker: () => null }));
vi.mock("./login-fields-editor", () => ({ LoginFieldsEditor: () => null }));
vi.mock("../native/native-action-button", () => ({
  NativeActionButton: ({ label }: { label: string }) =>
    createElement("button", { type: "button" }, label),
}));
vi.mock("../native/native-segmented-control", () => ({ NativeSegmentedControl: () => null }));
vi.mock("../settings/settings-group", () => ({ SettingsRow: () => null }));

const apiKey = {
  name: "stripe",
  origin: "https://api.example.test",
  auth: { type: "bearer" },
  title: "api.example.test",
  note: "",
  policy: "allow",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
} as VaultItem;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  resetI18nForTests();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(props: {
  kind: "api_key" | "contact" | "login";
  item?: VaultItem;
  revealed?: VaultRevealed;
  ask?: boolean;
}) {
  await act(async () =>
    root.render(
      createElement(VaultItemEditor, { ...props, onClose: () => {}, onSave: async () => {} }),
    ),
  );
}

const input = (label: string) =>
  [...container.querySelectorAll("input")].find(
    (node) => node.getAttribute("aria-label") === label,
  )!;

it("caps Title and When to use at the lengths the server accepts", async () => {
  await render({ kind: "api_key", item: apiKey });
  expect(input("Title").maxLength).toBe(80);
  expect(input("When to use").maxLength).toBe(200);
});

it("says why a login's authenticator key can't be saved", async () => {
  // A saved key opens the key field, so the test can type into it.
  await render({ kind: "login", revealed: { fields: [], otp: "saved" } });
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
      input("Authenticator key"),
      "xyz",
    );
    input("Authenticator key").dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(container.textContent).toContain("This authenticator key can't be read.");
});

it("shows no key error on a chat card, which answers without a key", async () => {
  await render({ kind: "login", ask: true });
  expect(container.textContent).not.toContain("Add an authenticator key");
  expect(container.textContent).not.toContain("This authenticator key can't be read.");
});

it("caps a contact's Label at the same title length", async () => {
  await render({ kind: "contact" });
  expect(input("Label").maxLength).toBe(80);
  expect(input("When to use").maxLength).toBe(200);
});
