// @vitest-environment jsdom

import type { Deferred } from "@rakazo/core/test-async";
import { deferred, flush } from "@rakazo/core/test-async";
import type { ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AddApprovalRule from "../../app/(settings)/approval-rule-add";
import Approvals from "../../app/(settings)/approvals";
import { queryClient } from "../query/query";

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
  selectedSpace: "space-selected",
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

vi.mock("../layout/side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("../appearance/appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("../native/native", () => ({
  native: {},
  useResolvedAppearance: () => "light",
  useThemedStyles: (factory: () => unknown) => factory(),
}));
vi.mock("../api/user-error", () => ({ errorText: (_: unknown, fallback: string) => fallback }));
vi.mock("../api/api", () => ({
  rpc: state.rpc,
  currentApiBase: () => "https://app.example.test",
  selectedSpaceId: () => state.selectedSpace,
  captureApiRequestContext: async (spaceId: string | null = state.selectedSpace) => ({
    apiBase: "https://app.example.test",
    sessionGeneration: 1,
    headers: spaceId ? { "x-rakazo-space-id": spaceId } : {},
  }),
}));
vi.mock("../api/session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("../platform/app-foreground", () => ({ useAppForeground: () => true }));
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
vi.mock("../native/native-controls", () => ({ iosAtLeast: () => true }));
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
vi.mock("../../components/native/native-action-button", () => ({
  NativeActionButton: ({ label, onPress }: { label: string; onPress: () => void }) =>
    createElement("button", { type: "button", onClick: onPress }, label),
}));
vi.mock("../../components/native/native-segmented-control", () => ({
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
vi.mock("../../components/settings/settings-group", () => ({
  SettingsFooter: element("small"),
  SettingsGroup: ({ label, children }: { label?: string; children?: ReactNode }) =>
    createElement("section", { "data-label": label }, children),
  SettingsRow: ({
    title,
    onPress,
    dimmed,
    disabled,
  }: {
    title: string;
    onPress?: () => void;
    dimmed?: boolean;
    disabled?: boolean;
  }) =>
    createElement(
      "span",
      {
        onClick: disabled ? undefined : onPress,
        "data-dimmed": dimmed || undefined,
        "data-disabled": disabled || undefined,
      },
      title,
    ),
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
  await act(flush);
}
async function press(node: HTMLElement | undefined) {
  await act(async () => node!.click());
}
async function renderPicker() {
  await act(async () => root.render(createElement(AddApprovalRule)));
  await act(flush);
}
const tool = (label: string) =>
  [...container.querySelectorAll("span")].find((node) => node.textContent === label);
/** What a request carries: the server and session it was started in, and the Space it names. */
const pinnedTo = (spaceId: string) => ({
  requestContext: {
    apiBase: "https://app.example.test",
    sessionGeneration: 1,
    headers: { "x-rakazo-space-id": spaceId },
  },
});

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  queryClient.clear();
  state.spaceId = undefined;
  state.selectedSpace = "space-selected";
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

  await press(menuButton("example.com", "Blocked"));
  expect(state.rpc).toHaveBeenCalledWith(
    "approvalRules/set",
    { scope: "account", effect: "deny", matchKind: "site", matchValue: "example.com" },
    pinnedTo("space-selected"),
  );
  expect(rows()).toEqual(["Always allow: Send email", "Always ask: Email", "Blocked: example.com"]);

  await press(menuButton("Send email", "Remove"));
  expect(state.rpc).toHaveBeenCalledWith(
    "approvalRules/remove",
    { scope: "account", id: "tool" },
    pinnedTo("space-selected"),
  );
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
  const spaceContext = { signal: expect.any(AbortSignal), ...pinnedTo("space-1") };
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
  await act(flush);
  expect(rows()).toEqual(["Always allow: Send email"]);
  expect(retry()).toBeUndefined();
  expect(container.textContent).not.toContain("Something went wrong. Try again.");
});

it("adds a tool from the picker, which searches and leaves out tools that have a rule", async () => {
  state.rules = [rule({ id: "blocked", effect: "deny", matchValue: "write_file" })];
  await renderPicker();
  const picker = () => [...container.querySelectorAll("span")].map((node) => node.textContent);
  expect(picker()).toContain("Shell");
  expect(picker()).not.toContain("Write file");

  await act(async () => state.search!.onChangeText({ nativeEvent: { text: "shel" } }));
  expect(picker()).toEqual(["Shell", "User computer shell"]);

  await act(async () => state.search!.onChangeText({ nativeEvent: { text: "zzz" } }));
  expect(picker()).toEqual([]);
  expect(container.textContent).toContain("No matches");

  await act(async () => state.search!.onChangeText({ nativeEvent: { text: "shel" } }));
  await press(tool("Shell"));
  expect(state.rpc).toHaveBeenCalledWith(
    "approvalRules/set",
    { scope: "account", effect: "require_approval", matchKind: "tool", matchValue: "shell" },
    pinnedTo("space-selected"),
  );
  // The list the picker builds its choices from is read again once the rule is saved.
  const procs = state.rpc.mock.calls.map(([proc]) => proc);
  expect(procs.lastIndexOf("approvalRules/list")).toBeGreaterThan(
    procs.indexOf("approvalRules/set"),
  );
  expect(state.router.back).toHaveBeenCalled();
});

it("reads the rules again when the picker opens, so a tool given a rule elsewhere is left out", async () => {
  await render();
  state.rules = [rule({ id: "elsewhere", matchValue: "shell" })];
  await renderPicker();
  expect(tool("Shell")).toBeUndefined();
  expect(tool("Write file")).toBeDefined();
});

it("saves once and goes back once when a tool is tapped twice", async () => {
  await renderPicker();
  await act(async () => {
    tool("Shell")!.click();
    tool("Shell")!.click();
  });
  expect(state.rpc.mock.calls.filter(([proc]) => proc === "approvalRules/set")).toHaveLength(1);
  expect(state.router.back).toHaveBeenCalledTimes(1);
  // The picker stays held while it closes, so a tap then cannot add the rule or go back again.
  await act(async () => tool("Shell")?.click());
  expect(state.rpc.mock.calls.filter(([proc]) => proc === "approvalRules/set")).toHaveLength(1);
  expect(state.router.back).toHaveBeenCalledTimes(1);
});

it("opens the rules after saving when the picker was the first screen", async () => {
  state.spaceId = "space-1";
  state.router.canGoBack.mockReturnValue(false);
  await renderPicker();
  await press(tool("Shell"));
  expect(state.rpc).toHaveBeenCalledWith(
    "approvalRules/set",
    { scope: "space", effect: "require_approval", matchKind: "tool", matchValue: "shell" },
    pinnedTo("space-1"),
  );
  expect(state.router.back).not.toHaveBeenCalled();
  expect(state.router.replace).toHaveBeenCalledWith({
    pathname: "/approvals",
    params: { spaceId: "space-1" },
  });
});

it("offers a retry when the picker's tools fail to load", async () => {
  state.rpc.mockImplementationOnce(async () => {
    throw new Error("offline");
  });
  await renderPicker();
  expect(container.textContent).toContain("Something went wrong. Try again.");
  expect(tool("Shell")).toBeUndefined();

  await act(async () => retry()!.click());
  await act(flush);
  expect(tool("Shell")).toBeDefined();
  expect(retry()).toBeUndefined();
  expect(container.textContent).not.toContain("Something went wrong. Try again.");
});

it("holds the picker while a tool saves, and shows a failed save until the next one starts", async () => {
  await renderPicker();
  const answers = state.rpc.getMockImplementation()!;
  let finish = holdSave();
  await press(tool("Shell"));
  expect(container.querySelectorAll("span:not([data-disabled])")).toHaveLength(0);
  await press(tool("Write file"));
  expect(saves()).toHaveLength(1);

  await act(async () => finish(new Error("offline")));
  expect(container.textContent).toContain("Could not save that preference");
  expect(container.querySelectorAll("span[data-disabled]")).toHaveLength(0);
  expect(state.router.back).not.toHaveBeenCalled();

  state.rpc.mockImplementation(answers);
  finish = holdSave();
  await press(tool("Shell"));
  expect(container.textContent).not.toContain("Could not save that preference");
  await act(async () => finish());
  expect(saves()).toHaveLength(2);
  expect(state.router.back).toHaveBeenCalledTimes(1);
});

it.each([
  ["succeeds", undefined],
  ["fails", new Error("offline")],
])(
  "leaves navigation alone when a tool's save %s after the picker has gone",
  async (_how, outcome) => {
    await renderPicker();
    const finish = holdSave();
    await press(tool("Shell"));
    await act(async () => root.render(createElement("div")));
    await act(async () => finish(outcome));
    expect(state.router.back).not.toHaveBeenCalled();
    expect(state.router.replace).not.toHaveBeenCalled();

    await renderPicker();
    expect(container.textContent).not.toContain("Could not save that preference");
    expect(container.querySelectorAll("span[data-disabled]")).toHaveLength(0);
  },
);

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
  let finishRead!: Deferred<Rule[]>;
  const fallback = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation((proc: string, ...rest: unknown[]) => {
    if (proc !== "approvalRules/list")
      return fallback(proc, ...(rest as [Record<string, unknown>]));
    finishRead = deferred<Rule[]>();
    return finishRead.promise;
  });
  await act(async () => root.render(createElement("div")));
  await render();
  await press(menuButton("example.com", "Blocked"));
  expect(rows()).toEqual(["Blocked: example.com"]);
  await act(async () =>
    finishRead.resolve([rule({ id: "site", matchKind: "site", matchValue: "example.com" })]),
  );
  expect(rows()).toEqual(["Blocked: example.com"]);
});

it("keeps a saved move, with no save error, when the next read fails", async () => {
  state.rules = [rule({ id: "site", matchKind: "site", matchValue: "example.com" })];
  await render();
  await press(menuButton("example.com", "Blocked"));
  expect(rows()).toEqual(["Blocked: example.com"]);

  const fallback = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation(async (proc: string, ...rest: unknown[]) => {
    if (proc === "approvalRules/list") throw new Error("offline");
    return fallback(proc, ...(rest as [Record<string, unknown>]));
  });
  await act(async () => root.render(createElement("div")));
  await render();
  expect(rows()).toEqual(["Blocked: example.com"]);
  expect(container.querySelector("span[data-dimmed]")).toBeNull();
  expect(container.textContent).toContain("Something went wrong. Try again.");
  expect(container.textContent).not.toContain("Could not save that preference");
});

/** Holds a rule's save open, so a test decides when and how it ends. */
function holdSave() {
  const fallback = state.rpc.getMockImplementation()!;
  let finish!: (outcome?: Error) => void;
  state.rpc.mockImplementation((proc: string, ...rest: unknown[]) =>
    proc === "approvalRules/set"
      ? new Promise((resolve, reject) => {
          finish = (outcome) =>
            outcome
              ? reject(outcome)
              : resolve(fallback(proc, ...(rest as [Record<string, unknown>])));
        })
      : fallback(proc, ...(rest as [Record<string, unknown>])),
  );
  return (outcome?: Error) => finish(outcome);
}
const saves = () =>
  state.rpc.mock.calls.filter(
    ([proc]) => proc === "approvalRules/set" || proc === "approvalRules/remove",
  );

it("does not start a second save while one runs", async () => {
  state.rules = [
    rule({ id: "tool", matchValue: "send_email" }),
    rule({ id: "site", matchKind: "site", matchValue: "example.com" }),
  ];
  await render();
  const finish = holdSave();
  await press(menuButton("example.com", "Blocked"));
  expect(container.querySelectorAll("span[data-dimmed]")).toHaveLength(2);
  await press(menuButton("Send email", "Remove"));
  await press(menuButton("example.com", "Always ask"));
  expect(saves()).toHaveLength(1);

  await act(async () => finish());
  expect(rows()).toEqual(["Always allow: Send email", "Blocked: example.com"]);
  expect(container.querySelector("span[data-dimmed]")).toBeNull();
});

it("shows no error for a save that fails after the screen has gone", async () => {
  state.rules = [rule({ id: "site", matchKind: "site", matchValue: "example.com" })];
  await render();
  const finish = holdSave();
  await press(menuButton("example.com", "Blocked"));
  await act(async () => root.render(createElement("div")));
  await act(async () => finish(new Error("offline")));

  await render();
  expect(rows()).toEqual(["Always allow: example.com"]);
  expect(container.textContent).not.toContain("Could not save that preference");
  expect(container.querySelector("span[data-dimmed]")).toBeNull();
});

const outcomes = [
  ["succeeds", undefined],
  ["fails", new Error("offline")],
] as const;
// Neither belongs to the selected space, so selecting another one leaves their saves alone.
const owners = [
  ["the account's", undefined],
  ["a named Space's", "space-1"],
] as const;

describe.each(owners)("%s rules", (_owner, spaceId) => {
  beforeEach(() => {
    state.spaceId = spaceId;
  });

  it("are read once, whichever space is selected", async () => {
    state.rules = [rule({ id: "tool", matchValue: "send_email" })];
    await render();
    const reads = state.rpc.mock.calls.length;
    state.selectedSpace = "space-elsewhere";
    await render();
    expect(rows()).toEqual(["Always allow: Send email"]);
    expect(state.rpc.mock.calls).toHaveLength(reads);
  });

  it.each(outcomes)(
    "stay held for a save that %s after another space was selected, and show how it ended",
    async (_how, outcome) => {
      state.rules = [
        rule({ id: "tool", matchValue: "send_email" }),
        rule({ id: "site", matchKind: "site", matchValue: "example.com" }),
      ];
      await render();
      const finish = holdSave();
      await press(menuButton("example.com", "Blocked"));
      state.selectedSpace = "space-elsewhere";
      await render();
      expect(container.querySelectorAll("span[data-dimmed]")).toHaveLength(2);
      await press(menuButton("Send email", "Remove"));
      expect(saves()).toHaveLength(1);

      await act(async () => finish(outcome));
      expect(container.querySelector("span[data-dimmed]")).toBeNull();
      if (outcome) expect(container.textContent).toContain("Could not save that preference");
      else expect(rows()).toEqual(["Always allow: Send email", "Blocked: example.com"]);
    },
  );

  it.each(outcomes)(
    "hold the picker for a save that %s after another space was selected, which then leaves or says why",
    async (_how, outcome) => {
      await renderPicker();
      const finish = holdSave();
      await press(tool("Shell"));
      state.selectedSpace = "space-elsewhere";
      await renderPicker();
      expect(container.querySelectorAll("span:not([data-disabled])")).toHaveLength(0);
      await press(tool("Write file"));
      expect(saves()).toHaveLength(1);

      await act(async () => finish(outcome));
      expect(state.router.back).toHaveBeenCalledTimes(outcome ? 0 : 1);
      if (outcome) expect(container.textContent).toContain("Could not save that preference");
    },
  );
});
