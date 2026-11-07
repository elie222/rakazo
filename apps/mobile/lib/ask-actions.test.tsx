// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  Alert: { alert: vi.fn() },
  TextInput: () => null,
  View: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
}));
vi.mock("./appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("./native", () => ({ native: {} }));
vi.mock("./i18n", () => {
  const i18n = { t: (text: string) => text };
  return { useI18n: () => i18n };
});
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({ label }: { label: string }) =>
    createElement("button", { type: "button" }, label),
}));

import { AskActions } from "../components/AskActions";

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
