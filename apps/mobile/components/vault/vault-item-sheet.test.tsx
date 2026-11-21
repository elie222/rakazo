// @vitest-environment jsdom

import type { BotSecretMetadata } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resetI18nForTests } from "../../lib/i18n/i18n";
import { VaultItemSheet } from "./vault-item-sheet";

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
  View: element("div"),
}));
// The uses list reads through the app's API, which this sheet's tests never reach.
vi.mock("../../lib/inbox/activity", () => ({ formatActivityRelativeTime: () => "" }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({}) }));
vi.mock("expo-clipboard", () => ({ setStringAsync: async () => true }));
vi.mock("../native/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("./vault-tile", () => ({ VaultTile: element("div") }));
vi.mock("../native/native-action-button", () => ({
  NativeActionButton: ({ label }: { label: string }) =>
    createElement("button", { type: "button" }, label),
}));
// Each row as its title and value, a button when it does something.
vi.mock("../settings/settings-group", () => ({
  SettingsGroup: element("section"),
  SettingsRow: ({
    title,
    value,
    onPress,
    disabled,
  }: {
    title: string;
    value?: string;
    onPress?: () => void;
    disabled?: boolean;
  }) =>
    onPress
      ? createElement("button", { type: "button", onClick: onPress, disabled }, title)
      : createElement("p", null, `${title}${value ? `: ${value}` : ""}`),
}));

const login = {
  name: "portal",
  origin: "https://portal.example.test",
  auth: { type: "login" },
  title: "Portal",
  note: "",
  policy: "allow",
  preview: { username: "ada@example.test", passkey: "portal.example.test" },
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
} as BotSecretMetadata;

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

async function render(item: BotSecretMetadata, onRemovePasskey = vi.fn()) {
  const noop = () => {};
  await act(async () =>
    root.render(
      createElement(VaultItemSheet, {
        item,
        uses: [],
        busy: false,
        onClose: noop,
        onShow: noop,
        onEdit: noop,
        onRemove: noop,
        onRemovePasskey,
      }),
    ),
  );
  return onRemovePasskey;
}

const removePasskey = () =>
  [...container.querySelectorAll("button")].find((node) => node.textContent === "Remove passkey");

it("shows only the site of a login's passkey, and removes it on request", async () => {
  const onRemovePasskey = await render(login);
  expect(container.textContent).toContain("Passkey: portal.example.test");
  await act(async () => removePasskey()?.click());
  expect(onRemovePasskey).toHaveBeenCalledOnce();
});

it("offers no passkey on a login without one", async () => {
  await render({ ...login, preview: { username: "ada@example.test" } });
  expect(container.textContent).not.toContain("Passkey");
  expect(removePasskey()).toBeUndefined();
});
