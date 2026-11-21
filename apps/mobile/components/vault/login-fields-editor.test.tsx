// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resetI18nForTests } from "../../lib/i18n/i18n";
import { LoginFieldsEditor } from "./login-fields-editor";

vi.mock("../../lib/appearance/appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("../../lib/native/compose-available", () => ({ isComposeViewAvailable: () => false }));
vi.mock("../../lib/native/native", () => ({
  systemGreen: () => undefined,
  useResolvedAppearance: () => "light",
  useThemedStyles: (factory: () => unknown) => factory(),
}));
vi.mock("../native/native-action-button", () => ({ NativeActionButton: () => null }));
vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
  Switch: ({
    accessibilityLabel,
    accessibilityHint,
    value,
  }: {
    accessibilityLabel: string;
    accessibilityHint?: string;
    value: boolean;
  }) => (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      aria-label={accessibilityLabel}
      aria-description={accessibilityHint}
    />
  ),
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  TextInput: () => null,
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

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

it("describes each Hidden switch with its field's name", () => {
  act(() =>
    root.render(
      <LoginFieldsEditor
        fields={["Username", " Password ", "   "].map((label, id) => ({
          id,
          label,
          value: "",
          hidden: true,
        }))}
        editable
        inputs={{ current: [] }}
        onChange={vi.fn()}
        onEndEditing={vi.fn()}
        onSubmit={vi.fn()}
      />,
    ),
  );

  const switches = [...container.querySelectorAll('[role="switch"]')];
  expect(switches.map((control) => control.getAttribute("aria-label"))).toEqual([
    "Hidden",
    "Hidden",
    "Hidden",
  ]);
  expect(switches.map((control) => control.getAttribute("aria-description"))).toEqual([
    "Username",
    "Password",
    "Value",
  ]);
});

it("asks no Hidden switch for a request's fixed fields", () => {
  act(() =>
    root.render(
      <LoginFieldsEditor
        fields={["Account", "Passphrase"].map((label, id) => ({
          id,
          label,
          value: "",
          hidden: id === 1,
        }))}
        labels={["Username", "Password"]}
        editable
        inputs={{ current: [] }}
        onChange={vi.fn()}
        onEndEditing={vi.fn()}
        onSubmit={vi.fn()}
      />,
    ),
  );

  expect(container.querySelector('[role="switch"]')).toBeNull();
});
