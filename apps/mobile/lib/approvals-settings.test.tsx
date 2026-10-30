// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Approvals from "../app/(settings)/approvals";

type Rule = {
  id: string;
  effect: "always_allow" | "require_approval" | "deny";
  matchKind: "tool" | "connector" | "category" | "site";
  matchValue: string;
  createdAt: string;
};
const state = vi.hoisted(() => ({
  rpc: vi.fn(),
  spaceId: undefined as string | undefined,
  settings: { mode: "ask", enabled: false, skipApprovals: false, checkerAvailable: false },
  rules: [] as Rule[],
}));
const { element } = vi.hoisted(() => ({
  element:
    (tag: string) =>
    ({ children }: { children?: ReactNode }) =>
      createElement(tag, null, children),
}));

vi.mock("./side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("./appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("./native", () => ({
  native: {},
  useResolvedAppearance: () => "light",
  useMobileTokens: () => ({}),
  useThemedStyles: (factory: () => unknown) => factory(),
}));
vi.mock("./i18n", () => {
  const i18n = { t: (text: string) => text };
  return { useI18n: () => i18n };
});
vi.mock("./user-error", () => ({ errorText: (_: unknown, fallback: string) => fallback }));
vi.mock("./api", () => ({
  rpc: state.rpc,
  captureApiRequestContext: async (spaceId: string) => ({ headers: { space: spaceId } }),
}));
vi.mock("expo-router", () => ({
  useFocusEffect: (effect: () => undefined | (() => void)) => useEffect(effect, [effect]),
  useLocalSearchParams: () => ({ spaceId: state.spaceId }),
}));
vi.mock("react-native", () => ({
  ScrollView: element("div"),
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: element("p"),
  TextInput: ({ value, accessibilityLabel }: { value: string; accessibilityLabel: string }) =>
    createElement("input", { value, readOnly: true, "aria-label": accessibilityLabel }),
  View: element("div"),
}));
vi.mock("react-native-safe-area-context", () => ({ SafeAreaView: element("div") }));
vi.mock("@expo/ui/community/menu", () => ({
  MenuView: ({
    actions,
    onPressAction,
    title,
    children,
  }: {
    actions: { id: string; title: string; state?: string }[];
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
    title: string;
    children: ReactNode;
  }) =>
    createElement(
      "div",
      { "aria-label": title },
      children,
      actions.map((action) =>
        createElement(
          "button",
          {
            key: action.id,
            type: "button",
            "aria-pressed": action.state === "on",
            onClick: () => onPressAction({ nativeEvent: { event: action.id } }),
          },
          action.title,
        ),
      ),
    ),
}));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({ label, onPress }: { label: string; onPress: () => void }) =>
    createElement("button", { type: "button", onClick: onPress }, label),
}));
vi.mock("../components/native-segmented-control", () => ({
  NativeSegmentedControl: ({
    options,
    value,
    onChange,
  }: {
    options: { value: string; label: string }[];
    value?: string;
    onChange: (value: string) => void;
  }) =>
    createElement(
      "div",
      { role: "radiogroup" },
      options.map((option) =>
        createElement(
          "button",
          {
            key: option.value,
            type: "button",
            role: "radio",
            "aria-checked": option.value === value,
            onClick: () => onChange(option.value),
          },
          option.label,
        ),
      ),
    ),
}));
vi.mock("../components/settings-group", () => ({
  SettingsFooter: element("small"),
  SettingsGroup: element("section"),
  SettingsRow: ({ title, value }: { title: string; value?: string }) =>
    createElement("span", null, `${title}: ${value}`),
}));

let root: Root;
let container: HTMLDivElement;
const rows = () => [...container.querySelectorAll("span")].map((node) => node.textContent);
const menu = (title: string) => container.querySelector(`[aria-label="${title}"]`)!;
const menuButton = (title: string, action: string) =>
  [...menu(title).querySelectorAll("button")].find((node) => node.textContent === action);
const rule = (overrides: Partial<Rule> & Pick<Rule, "id">): Rule => ({
  effect: "always_allow",
  matchKind: "tool",
  matchValue: "send_email",
  createdAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

async function render() {
  await act(async () => root.render(createElement(Approvals)));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.spaceId = undefined;
  state.settings = { mode: "ask", enabled: false, skipApprovals: false, checkerAvailable: false };
  state.rules = [];
  state.rpc
    .mockReset()
    .mockImplementation(async (proc: string, input?: Record<string, unknown>) => {
      if (proc === "autoReview/get") return state.settings;
      if (proc === "autoReview/set") {
        state.settings = { ...state.settings, mode: input!.mode as string };
        return state.settings;
      }
      if (proc === "approvalRules/list") return state.rules;
      if (proc === "approvalRules/preview") return { before: "always_allow", after: "default" };
      if (proc === "approvalRules/set")
        return rule({
          id: "saved",
          effect: input!.effect as Rule["effect"],
          matchKind: input!.matchKind as Rule["matchKind"],
          matchValue: input!.matchValue as string,
        });
      if (proc === "approvalRules/remove") return { ok: true };
      throw new Error(`Unexpected RPC: ${proc}`);
    });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

it("previews a rule without saving it in the selected space", async () => {
  state.spaceId = "space-preview";
  state.rules = [rule({ id: "preview-rule" })];
  await render();
  await act(async () => menuButton("Send email", "Preview")!.click());
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Test rule")!
      .click(),
  );
  expect(state.rpc).toHaveBeenCalledWith(
    "approvalRules/preview",
    {
      scope: "space",
      id: "preview-rule",
      effect: "remove",
      sample: { tools: [{ name: "send_email" }] },
    },
    { requestContext: { headers: { space: "space-preview" } } },
  );
  expect(container.textContent).toContain("Current: Allow rule → Preview: No matching rule");
  expect(
    state.rpc.mock.calls.some(
      ([proc]) => proc === "approvalRules/set" || proc === "approvalRules/remove",
    ),
  ).toBe(false);
});

it("clears a preview and ignores old responses when another saved rule is removed", async () => {
  state.rules = [
    rule({ id: "tool" }),
    rule({ id: "connector", matchKind: "connector", matchValue: "gmail", effect: "deny" }),
  ];
  await render();
  await act(async () => menuButton("Send email", "Preview")!.click());
  const testButton = () =>
    [...container.querySelectorAll("button")].find((entry) => entry.textContent === "Test rule")!;
  await act(async () => testButton().click());
  expect(container.textContent).toContain("Current: Allow rule");
  await act(async () => menuButton("gmail", "Allow")!.click());
  expect(container.textContent).not.toContain("Current: Allow rule");
  const base = state.rpc.getMockImplementation()!;
  let finish!: (value: { before: string; after: string }) => void;
  state.rpc.mockImplementation((proc: string, input?: Record<string, unknown>) =>
    proc === "approvalRules/preview"
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : base(proc, input),
  );
  await act(async () => testButton().click());
  await act(async () => menuButton("gmail", "Remove")!.click());
  await act(async () => finish({ before: "deny", after: "deny" }));
  expect(container.textContent).not.toContain("Current: Block rule");
  expect(container.textContent).not.toContain("Current: Allow rule");
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("lists only the rules; the mode is a row in settings", async () => {
  state.rules = [rule({ id: "tool", matchValue: "send_email" })];
  await render();
  expect(rows()).toEqual(["Send email: Allow"]);
  expect(container.querySelector('[role="radiogroup"]')).toBeNull();
  expect(container.querySelector("small")).toBeNull();
  expect(state.rpc.mock.calls.map(([proc]) => proc)).toEqual(["approvalRules/list"]);
});

it("switches and removes rules, keeping legacy category rules removable only", async () => {
  state.rules = [
    rule({ id: "tool", matchValue: "send_email" }),
    rule({ id: "site", effect: "require_approval", matchKind: "site", matchValue: "example.com" }),
    rule({
      id: "category",
      effect: "require_approval",
      matchKind: "category",
      matchValue: "email",
    }),
  ];
  await render();
  expect(rows()).toEqual(["Send email: Allow", "example.com: Ask", "email: Ask"]);
  expect(menuButton("Send email", "Allow")?.getAttribute("aria-pressed")).toBe("true");
  expect(menuButton("email", "Allow")).toBeUndefined();

  await act(async () => menuButton("example.com", "Block")!.click());
  expect(state.rpc).toHaveBeenCalledWith("approvalRules/set", {
    scope: "account",
    effect: "deny",
    matchKind: "site",
    matchValue: "example.com",
  });
  expect(rows()).toEqual(["Send email: Allow", "example.com: Block", "email: Ask"]);

  await act(async () => menuButton("Send email", "Remove")!.click());
  expect(state.rpc).toHaveBeenCalledWith("approvalRules/remove", { scope: "account", id: "tool" });
  expect(rows()).toEqual(["example.com: Block", "email: Ask"]);
});

it("edits a Space's own copy when opened with one", async () => {
  state.spaceId = "space-1";
  await render();
  const spaceContext = { requestContext: { headers: { space: "space-1" } } };
  expect(state.rpc.mock.calls).toEqual([["approvalRules/list", { scope: "space" }, spaceContext]]);
});

function retry() {
  return [...container.querySelectorAll("button")].find((node) => node.textContent === "Retry");
}

it("offers a retry when the first load fails, then shows the rules", async () => {
  state.rules = [rule({ id: "tool", matchValue: "send_email" })];
  state.rpc.mockImplementationOnce(async () => {
    throw new Error("offline");
  });
  await render();
  expect(container.textContent).toContain("Something went wrong. Try again.");
  expect(rows()).toEqual([]);

  await act(async () => retry()!.click());
  expect(rows()).toEqual(["Send email: Allow"]);
  expect(retry()).toBeUndefined();
  expect(container.textContent).not.toContain("Something went wrong. Try again.");
});
