// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  ActivityIndicator: () => null,
  Alert: { alert: vi.fn() },
  Pressable: ({
    children,
    accessibilityLabel,
    accessibilityState,
    onPress,
  }: {
    children?: ReactNode;
    accessibilityLabel?: string;
    accessibilityState?: { selected?: boolean };
    onPress?: () => void;
  }) =>
    createElement(
      "button",
      {
        type: "button",
        "aria-label": accessibilityLabel,
        "aria-pressed": accessibilityState?.selected ? "true" : "false",
        onClick: onPress,
      },
      children,
    ),
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: ({ children }: { children?: ReactNode }) => createElement("span", null, children),
  TextInput: () => null,
  View: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
}));
vi.mock("../../lib/appearance/appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("../../lib/native/native", () => ({ native: {} }));
vi.mock("../native/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("../native/native-action-button", () => ({
  NativeActionButton: ({ label }: { label: string }) =>
    createElement("button", { type: "button" }, label),
}));

import { AskActions } from "./AskActions";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

it("offers Always allow only when the approval card does", async () => {
  const actions = [
    { id: "allow", label: "Allow once" },
    { id: "always", label: "Always allow this tool" },
    { id: "deny", label: "Deny" },
  ];
  const show = (shown: typeof actions) =>
    act(async () =>
      root.render(<AskActions actions={shown} approval onAnswer={async () => undefined} />),
    );
  const labels = () => [...container.querySelectorAll("button")].map((item) => item.textContent);
  await show(actions);
  expect(labels()).toEqual(["Allow once", "Always allow this tool", "Deny"]);
  await show(actions.filter((action) => action.id !== "always"));
  expect(labels()).toEqual(["Allow once", "Deny"]);
});

it("lists a question's options as rows and marks the chosen one", async () => {
  const onAnswer = vi.fn(async () => undefined);
  const actions = [
    { id: "research", label: "Research markets" },
    { id: "draft", label: "Draft emails" },
  ];
  await act(async () =>
    root.render(<AskActions actions={actions} approval={false} onAnswer={onAnswer} />),
  );
  const rows = () => [...container.querySelectorAll("button")];
  expect(rows().map((row) => row.getAttribute("aria-label"))).toEqual([
    "Research markets",
    "Draft emails",
  ]);
  await act(async () => rows()[1]?.click());
  expect(onAnswer).toHaveBeenCalledWith("draft");

  await act(async () =>
    root.render(
      <AskActions
        actions={actions}
        approval={false}
        disabled
        selectedAnswer="draft"
        onAnswer={onAnswer}
      />,
    ),
  );
  expect(rows().map((row) => row.getAttribute("aria-pressed"))).toEqual(["false", "true"]);
});
