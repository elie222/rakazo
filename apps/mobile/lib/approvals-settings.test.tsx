// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
import AddApprovalRule from "../app/(settings)/approval-rule-add";
import Approvals from "../app/(settings)/approvals";
import { queryClient } from "./query";

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
  headerItems: [] as { label: string; onPress: () => void }[],
  search: null as null | { onChangeText: (event: { nativeEvent: { text: string } }) => void },
  router: { push: vi.fn(), back: vi.fn(), replace: vi.fn(), canGoBack: vi.fn(() => true) },
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
  useThemedStyles: (factory: () => unknown) => factory(),
}));
vi.mock("./i18n", () => {
  const i18n = { t: (text: string) => text };
  return { useI18n: () => i18n };
});
vi.mock("./user-error", () => ({ errorText: (_: unknown, fallback: string) => fallback }));
vi.mock("./api-server", () => ({}));
vi.mock("./api-auth", () => ({}));
vi.mock("./api-live", () => ({}));
vi.mock("./api", () => ({
  rpc: state.rpc,
  currentApiBase: () => "https://app.example.test",
  selectedSpaceId: () => "space-selected",
  captureApiRequestContext: async (spaceId: string) => ({ headers: { space: spaceId } }),
}));
vi.mock("./session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("expo-router", () => ({
  useFocusEffect: (effect: () => undefined | (() => void)) => useEffect(effect, [effect]),
  useLocalSearchParams: () => ({ spaceId: state.spaceId }),
  useNavigation: () => ({
    setOptions: (options: {
      unstable_headerRightItems?: () => typeof state.headerItems;
      headerSearchBarOptions?: typeof state.search;
    }) => {
      if (options.unstable_headerRightItems)
        state.headerItems = options.unstable_headerRightItems();
      if (options.headerSearchBarOptions) state.search = options.headerSearchBarOptions;
    },
  }),
  useRouter: () => state.router,
}));
vi.mock("./native-controls", () => ({ iosAtLeast: () => true }));
vi.mock("react-native", () => ({
  ScrollView: element("div"),
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: element("p"),
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
  SettingsGroup: ({ label, children }: { label?: string; children?: ReactNode }) =>
    createElement("section", { "data-label": label }, children),
  SettingsRow: ({
    title,
    onPress,
    dimmed,
  }: {
    title: string;
    onPress?: () => void;
    dimmed?: boolean;
  }) => createElement("span", { onClick: onPress, "data-dimmed": dimmed || undefined }, title),
}));

let root: Root;
let container: HTMLDivElement;
/** Each rule as "group: title", in the order shown. */
const rows = () =>
  [...container.querySelectorAll("span")].map(
    (node) => `${node.closest("section")?.getAttribute("data-label")}: ${node.textContent}`,
  );
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
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  queryClient.clear();
  state.spaceId = undefined;
  state.settings = { mode: "ask", enabled: false, skipApprovals: false, checkerAvailable: false };
  state.rules = [];
  state.headerItems = [];
  state.search = null;
  state.router.push.mockReset();
  state.router.back.mockReset();
  state.router.replace.mockReset();
  state.router.canGoBack.mockReset().mockReturnValue(true);
  state.rpc
    .mockReset()
    .mockImplementation(async (proc: string, input?: Record<string, unknown>) => {
      if (proc === "autoReview/get") return state.settings;
      if (proc === "autoReview/set") {
        state.settings = { ...state.settings, mode: input!.mode as string };
        return state.settings;
      }
      if (proc === "approvalRules/list") return state.rules;
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

it("lists only the rules, grouped by what they do; the mode is a row in settings", async () => {
  state.rules = [rule({ id: "tool", matchValue: "send_email" })];
  await render();
  expect(rows()).toEqual(["Always allow: Send email"]);
  expect(container.querySelector('[role="radiogroup"]')).toBeNull();
  expect(container.querySelector("small")).toBeNull();
  expect(state.rpc.mock.calls.map(([proc]) => proc)).toEqual([
    "approvalRules/list",
    "autoReview/get",
  ]);
});

it("moves and removes rules, keeping legacy category rules removable only", async () => {
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
  expect(rows()).toEqual([
    "Always allow: Send email",
    "Always ask: example.com",
    "Always ask: Email",
  ]);
  expect(menuButton("Send email", "Always allow")?.getAttribute("aria-pressed")).toBe("true");
  expect(menuButton("Email", "Always allow")).toBeUndefined();
  expect(menuButton("Email", "Remove")).toBeDefined();

  await act(async () => menuButton("example.com", "Blocked")!.click());
  expect(state.rpc).toHaveBeenCalledWith("approvalRules/set", {
    scope: "account",
    effect: "deny",
    matchKind: "site",
    matchValue: "example.com",
  });
  expect(rows()).toEqual(["Always allow: Send email", "Always ask: Email", "Blocked: example.com"]);

  await act(async () => menuButton("Send email", "Remove")!.click());
  expect(state.rpc).toHaveBeenCalledWith("approvalRules/remove", { scope: "account", id: "tool" });
  expect(rows()).toEqual(["Always ask: Email", "Blocked: example.com"]);
});

it("offers Ask and Block, not Allow, for a tool a person approves every time", async () => {
  state.rules = [rule({ id: "space", effect: "require_approval", matchValue: "create_space" })];
  await render();
  expect(menuButton("Create space", "Always ask")).toBeDefined();
  expect(menuButton("Create space", "Blocked")).toBeDefined();
  expect(menuButton("Create space", "Always allow")).toBeUndefined();
});

it("dims every rule but blocks in Never ask, where only blocks apply", async () => {
  state.settings = { ...state.settings, mode: "never" };
  state.rules = [
    rule({ id: "allow", matchValue: "send_email" }),
    rule({ id: "ask", effect: "require_approval", matchValue: "write_file" }),
    rule({ id: "block", effect: "deny", matchValue: "shell" }),
  ];
  await render();
  const dimmed = [...container.querySelectorAll("span[data-dimmed]")].map((n) => n.textContent);
  expect(dimmed).toEqual(["Send email", "Write file"]);
});

it("edits a Space's own copy when opened with one", async () => {
  state.spaceId = "space-1";
  await render();
  const spaceContext = {
    signal: expect.any(AbortSignal),
    requestContext: { headers: { space: "space-1" } },
  };
  expect(state.rpc.mock.calls).toEqual([
    ["approvalRules/list", { scope: "space" }, spaceContext],
    ["autoReview/get", { scope: "space" }, spaceContext],
  ]);
  await act(async () => state.headerItems.find((item) => item.label === "Add rule")!.onPress());
  expect(state.router.push).toHaveBeenCalledWith({
    pathname: "/approval-rule-add",
    params: { spaceId: "space-1" },
  });
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
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(rows()).toEqual(["Always allow: Send email"]);
  expect(retry()).toBeUndefined();
  expect(container.textContent).not.toContain("Something went wrong. Try again.");
});

it("adds a tool from the picker, which searches and leaves out tools that have a rule", async () => {
  state.rules = [rule({ id: "blocked", effect: "deny", matchValue: "write_file" })];
  await act(async () => root.render(createElement(AddApprovalRule)));
  const picker = () => [...container.querySelectorAll("span")].map((node) => node.textContent);
  expect(picker()).toContain("Shell");
  expect(picker()).not.toContain("Write file");

  await act(async () => state.search!.onChangeText({ nativeEvent: { text: "shel" } }));
  expect(picker()).toEqual(["Shell", "User computer shell"]);

  await act(async () => state.search!.onChangeText({ nativeEvent: { text: "zzz" } }));
  expect(picker()).toEqual([]);
  expect(container.textContent).toContain("No matches");

  await act(async () => state.search!.onChangeText({ nativeEvent: { text: "shel" } }));
  const shell = [...container.querySelectorAll("span")].find(
    (node) => node.textContent === "Shell",
  );
  await act(async () => shell!.click());
  expect(state.rpc).toHaveBeenCalledWith("approvalRules/set", {
    scope: "account",
    effect: "require_approval",
    matchKind: "tool",
    matchValue: "shell",
  });
  expect(state.router.back).toHaveBeenCalled();
});

it("saves once and goes back once when a tool is tapped twice", async () => {
  await act(async () => root.render(createElement(AddApprovalRule)));
  const shell = [...container.querySelectorAll("span")].find(
    (node) => node.textContent === "Shell",
  );
  await act(async () => {
    shell!.click();
    shell!.click();
  });
  expect(state.rpc.mock.calls.filter(([proc]) => proc === "approvalRules/set")).toHaveLength(1);
  expect(state.router.back).toHaveBeenCalledTimes(1);
});

it("opens the rules after saving when the picker was the first screen", async () => {
  state.spaceId = "space-1";
  state.router.canGoBack.mockReturnValue(false);
  await act(async () => root.render(createElement(AddApprovalRule)));
  const shell = [...container.querySelectorAll("span")].find(
    (node) => node.textContent === "Shell",
  );
  await act(async () => shell!.click());
  expect(state.router.back).not.toHaveBeenCalled();
  expect(state.router.replace).toHaveBeenCalledWith({
    pathname: "/approvals",
    params: { spaceId: "space-1" },
  });
});

it("drops Never ask dimming when a later mode read fails", async () => {
  state.settings = { ...state.settings, mode: "never" };
  state.rules = [rule({ id: "allow", matchValue: "send_email" })];
  await render();
  expect(container.querySelector("span[data-dimmed]")).not.toBeNull();
  const fallback = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation(async (proc: string, ...rest: unknown[]) => {
    if (proc === "autoReview/get") throw new Error("offline");
    return fallback(proc, ...(rest as [Record<string, unknown>]));
  });
  await act(async () => root.render(createElement("div")));
  await render();
  expect(container.querySelector("span[data-dimmed]")).toBeNull();
});

it("keeps a saved move when a read that started before it lands later", async () => {
  state.rules = [rule({ id: "site", matchKind: "site", matchValue: "example.com" })];
  await render();
  let finishRead!: (rules: Rule[]) => void;
  const fallback = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation((proc: string, ...rest: unknown[]) =>
    proc === "approvalRules/list"
      ? new Promise((resolve) => (finishRead = resolve))
      : fallback(proc, ...(rest as [Record<string, unknown>])),
  );
  await act(async () => root.render(createElement("div")));
  await render();
  await act(async () => menuButton("example.com", "Blocked")!.click());
  expect(rows()).toEqual(["Blocked: example.com"]);
  await act(async () =>
    finishRead([rule({ id: "site", matchKind: "site", matchValue: "example.com" })]),
  );
  expect(rows()).toEqual(["Blocked: example.com"]);
});
