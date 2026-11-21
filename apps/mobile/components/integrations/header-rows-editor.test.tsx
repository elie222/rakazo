// @vitest-environment jsdom

import type { ModelHeaderRow } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));

vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  return {
    StyleSheet: { create: <T,>(styles: T) => styles },
    View: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
  };
});

vi.mock("../../lib/native/native", () => ({
  useMobileTokens: () => ({ link: "link" }),
  useThemedStyles: <T,>(factory: () => T) => factory(),
}));

vi.mock("../native/native-symbol", () => ({ NativeSymbol: () => null }));

// The settings rows forward their accessibility props to the native view; this stub exposes them.
vi.mock("../settings/settings-group", async () => {
  const { createElement } = await import("react");
  return {
    SettingsGroup: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
    SettingsInputRow: ({
      accessibilityLabel,
      accessibilityHint,
      value,
      onChangeText,
    }: {
      accessibilityLabel?: string;
      accessibilityHint?: string;
      value?: string;
      onChangeText?: (text: string) => void;
    }) =>
      createElement("input", {
        "aria-label": accessibilityLabel,
        "aria-description": accessibilityHint,
        value,
        onChange: (event: { target: { value: string } }) => onChangeText?.(event.target.value),
      }),
    SettingsRow: ({
      title,
      accessibilityLabel,
      accessibilityHint,
      onPress,
    }: {
      title: string;
      accessibilityLabel?: string;
      accessibilityHint?: string;
      onPress?: () => void;
    }) =>
      createElement(
        "button",
        {
          type: "button",
          "aria-label": accessibilityLabel,
          "aria-description": accessibilityHint,
          onClick: onPress,
        },
        title,
      ),
  };
});

import { HeaderRowsEditor } from "./header-rows-editor";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function render(rows: ModelHeaderRow[]) {
  act(() => {
    root.render(<HeaderRowsEditor rows={rows} onChange={vi.fn()} disabled={false} />);
  });
}

const valueFields = () => [...host.querySelectorAll(`input[aria-label="Header value"]`)];
const removeButtons = () => [...host.querySelectorAll(`button[aria-label="Remove header"]`)];
const hintOf = (element: Element) => element.getAttribute("aria-description");

it("gives each row's value field and Remove button that row's header name as its hint", () => {
  render([
    { name: "Authorization", value: "" },
    { name: "X-Org", value: "" },
  ]);

  expect(valueFields().map(hintOf)).toEqual(["Authorization", "X-Org"]);
  expect(removeButtons().map(hintOf)).toEqual(["Authorization", "X-Org"]);
});

it("leaves the hint off a row whose name is still empty", () => {
  render([{ name: "", value: "" }]);

  expect(hintOf(valueFields()[0]!)).toBeNull();
  expect(hintOf(removeButtons()[0]!)).toBeNull();
});
