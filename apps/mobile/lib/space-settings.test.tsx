// @vitest-environment jsdom

import type { Deferred } from "@rakazo/core/test-async";
import { deferred, flush } from "@rakazo/core/test-async";
import type { ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SpaceSettings from "../app/(settings)/space";
import { queryClient } from "./query";

const state = vi.hoisted(() => ({
  push: vi.fn(),
  rpc: vi.fn(),
  alert: vi.fn(),
  overrides: [] as string[],
  focusCount: 0,
  rules: [] as { id: string }[],
  selectedSpace: "space-selected",
}));
type SwitchProps = {
  accessibilityLabel?: string;
  value: boolean;
  disabled?: boolean;
  onValueChange: (value: boolean) => void;
};
const { element, toggle } = vi.hoisted(() => ({
  element:
    (tag: string) =>
    ({ children, accessibilityLabel }: { children?: ReactNode; accessibilityLabel?: string }) =>
      createElement(tag, { "aria-label": accessibilityLabel }, children),
  toggle: ({ accessibilityLabel, value, disabled, onValueChange }: SwitchProps) =>
    createElement("input", {
      type: "checkbox",
      "aria-label": accessibilityLabel,
      checked: value,
      disabled,
      onChange: () => onValueChange(!value),
    }),
}));

vi.mock("./side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("./appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("./native", () => ({
  native: {},
  useResolvedAppearance: () => "light",
  useThemedStyles: (factory: () => unknown) => factory(),
}));
vi.mock("./user-error", () => ({ errorText: (_: unknown, fallback: string) => fallback }));
vi.mock("./api-server", () => ({}));
vi.mock("./api-auth", () => ({}));
vi.mock("./api-live", () => ({}));
vi.mock("./api", () => ({
  rpc: state.rpc,
  currentApiBase: () => "https://app.example.test",
  selectedSpaceId: () => state.selectedSpace,
  captureApiRequestContext: async (spaceId: string | null = state.selectedSpace) => ({
    apiBase: "https://app.example.test",
    sessionGeneration: 1,
    headers: spaceId ? { "x-rakazo-space-id": spaceId } : {},
  }),
}));
vi.mock("./session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("expo-router", () => ({
  useFocusEffect: (effect: () => undefined | (() => void)) =>
    useEffect(effect, [effect, state.focusCount]),
  useLocalSearchParams: () => ({ spaceId: "space-other", name: "Work" }),
  useRouter: () => ({ push: state.push }),
}));
vi.mock("react-native", () => ({
  Alert: { alert: state.alert },
  ScrollView: element("div"),
  View: element("div"),
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: element("span"),
}));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("@expo/ui/community/menu", () => ({
  MenuView: ({
    actions,
    onPressAction,
    children,
  }: {
    actions: { id: string; title: string }[];
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
    children: ReactNode;
  }) =>
    createElement(
      "div",
      null,
      children,
      actions.map((action) =>
        createElement(
          "button",
          {
            key: action.id,
            type: "button",
            "data-menu": "",
            onClick: () => onPressAction({ nativeEvent: { event: action.id } }),
          },
          action.title,
        ),
      ),
    ),
}));
vi.mock("react-native-safe-area-context", () => ({ SafeAreaView: element("div") }));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({ label, onPress }: { label: string; onPress: () => void }) =>
    createElement("button", { type: "button", onClick: onPress }, label),
}));
vi.mock("../components/native-switch", () => ({ NativeSwitch: toggle }));
vi.mock("../components/settings-group", () => ({
  SettingsGroup: element("section"),
  SettingsRow: ({
    title,
    value,
    onPress,
    trailing,
  }: {
    title: string;
    value?: string;
    onPress?: () => void;
    trailing?: ReactNode;
  }) =>
    createElement(
      "div",
      { "data-row": [title, value].filter(Boolean).join(": ") },
      onPress ? createElement("button", { type: "button", onClick: onPress }, title) : title,
      trailing,
    ),
}));

const spaceContext = {
  requestContext: {
    apiBase: "https://app.example.test",
    sessionGeneration: 1,
    headers: { "x-rakazo-space-id": "space-other" },
  },
};
let root: Root;
let container: HTMLDivElement;
async function render() {
  await act(async () => root.render(createElement(SpaceSettings)));
  await act(flush);
}
async function press(node: HTMLElement) {
  await act(async () => node.click());
}
const control = (label: string) =>
  container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  queryClient.clear();
  state.overrides = [];
  state.focusCount = 0;
  state.rules = [];
  state.selectedSpace = "space-selected";
  state.push.mockReset();
  state.alert.mockReset();
  state.rpc
    .mockReset()
    .mockImplementation(async (proc: string, input?: Record<string, unknown>) => {
      if (proc === "spaceSettings/overrides") return state.overrides;
      if (proc === "spaceSettings/setOverride") {
        const setting = input!.setting as string;
        state.overrides = input!.enabled
          ? [...state.overrides, setting]
          : state.overrides.filter((entry) => entry !== setting);
        return state.overrides;
      }
      if (proc === "autoReview/get")
        return { mode: "never", enabled: false, skipApprovals: true, checkerAvailable: false };
      if (proc === "approvalRules/list") return state.rules;
      throw new Error(`Unexpected RPC: ${proc}`);
    });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await render();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("follows the account until a setting is customized, then opens the same screen for the Space", async () => {
  expect(state.rpc).toHaveBeenCalledWith("spaceSettings/overrides", undefined, {
    ...spaceContext,
    signal: expect.any(AbortSignal),
  });
  for (const name of ["Models", "Voice", "Approvals", "Vault"])
    expect(control(`Customize ${name}`)?.checked).toBe(false);
  expect(container.querySelector("button")).toBeNull();

  await press(control("Customize Models")!);
  expect(state.rpc).toHaveBeenCalledWith(
    "spaceSettings/setOverride",
    { setting: "models", enabled: true },
    spaceContext,
  );
  expect(state.push).toHaveBeenCalledWith({
    pathname: "/models",
    params: { spaceId: "space-other" },
  });
  expect(control("Customize Models")?.checked).toBe(true);

  state.push.mockReset();
  await act(async () => container.querySelector("button")!.click());
  expect(state.push).toHaveBeenCalledWith({
    pathname: "/models",
    params: { spaceId: "space-other" },
  });

  await press(control("Customize Models")!);
  expect(state.rpc).toHaveBeenLastCalledWith(
    "spaceSettings/setOverride",
    { setting: "models", enabled: false },
    spaceContext,
  );
  expect(control("Customize Models")?.checked).toBe(false);
});

it("shows the Space's approval mode and rules right here once approvals are customized", async () => {
  const rows = () =>
    Array.from(container.querySelectorAll("[data-row]"), (row) => row.getAttribute("data-row"));
  expect(rows()).toEqual(["Models", "Voice", "Approvals", "Vault"]);
  expect(state.rpc).not.toHaveBeenCalledWith("autoReview/get", expect.anything(), spaceContext);

  state.rules = [{ id: "rule-1" }];
  await press(control("Customize Approvals")!);
  expect(state.rpc).toHaveBeenCalledWith(
    "spaceSettings/setOverride",
    { setting: "confirmations", enabled: true },
    spaceContext,
  );
  expect(state.push).not.toHaveBeenCalled();
  expect(state.rpc).toHaveBeenCalledWith("autoReview/get", { scope: "space" }, spaceContext);
  expect(state.rpc).toHaveBeenCalledWith("approvalRules/list", { scope: "space" }, spaceContext);
  expect(rows()).toEqual([
    "Models",
    "Voice",
    "Approvals",
    "Vault",
    "Approvals: Never ask",
    "Rules: 1",
  ]);

  await act(async () => container.querySelector<HTMLElement>("button:not([data-menu])")!.click());
  expect(state.push).toHaveBeenCalledWith({
    pathname: "/approvals",
    params: { spaceId: "space-other" },
  });

  await press(control("Customize Approvals")!);
  expect(rows()).toEqual(["Models", "Voice", "Approvals", "Vault"]);
});

it("holds the Approvals switch while the Space's mode is saving", async () => {
  await press(control("Customize Approvals")!);
  const base = state.rpc.getMockImplementation()!;
  let finish: () => void = () => undefined;
  state.rpc.mockImplementation((proc: string, input?: Record<string, unknown>) =>
    proc === "autoReview/set"
      ? new Promise((resolve) => {
          finish = () => resolve({ mode: input!.mode, checkerAvailable: false });
        })
      : base(proc, input),
  );
  const ask = [...container.querySelectorAll<HTMLElement>("[data-menu]")].find(
    (node) => node.textContent === "Ask",
  )!;
  await act(async () => ask.click());
  expect(state.rpc).toHaveBeenCalledWith(
    "autoReview/set",
    { scope: "space", mode: "ask" },
    spaceContext,
  );
  expect(control("Customize Approvals")?.disabled).toBe(true);
  expect(control("Customize Models")?.disabled).toBe(false);

  await act(async () => finish());
  expect(control("Customize Approvals")?.disabled).toBe(false);
});

type AlertButton = { text: string; style?: string; onPress?: () => void };
const alertButton = (text: string) =>
  (state.alert.mock.lastCall![2] as AlertButton[]).find((button) => button.text === text)!;

it("opens the Vault for the Space, and deletes its credentials only once confirmed", async () => {
  await press(control("Customize Vault")!);
  expect(state.rpc).toHaveBeenCalledWith(
    "spaceSettings/setOverride",
    { setting: "credentials", enabled: true },
    spaceContext,
  );
  expect(state.push).toHaveBeenCalledWith({
    pathname: "/vault",
    params: { spaceId: "space-other" },
  });
  state.rpc.mockClear();

  await act(async () => control("Customize Vault")!.click());
  expect(state.alert).toHaveBeenCalledWith(
    "Delete this Space's credentials?",
    undefined,
    expect.any(Array),
  );
  expect(alertButton("Delete").style).toBe("destructive");
  await act(async () => alertButton("Cancel").onPress?.());
  expect(state.rpc).not.toHaveBeenCalled();
  expect(control("Customize Vault")?.checked).toBe(true);

  await act(async () => control("Customize Vault")!.click());
  await act(async () => alertButton("Delete").onPress?.());
  expect(state.rpc).toHaveBeenCalledWith(
    "spaceSettings/setOverride",
    { setting: "credentials", enabled: false },
    spaceContext,
  );
  expect(control("Customize Vault")?.checked).toBe(false);
});

it("turns other settings off without asking", async () => {
  state.overrides = ["voice"];
  state.focusCount += 1;
  await render();
  await press(control("Customize Voice")!);
  expect(state.alert).not.toHaveBeenCalled();
  expect(control("Customize Voice")?.checked).toBe(false);
});

function retry() {
  return [...container.querySelectorAll("button")].find((node) => node.textContent === "Retry");
}

it("offers a retry when the overrides fail to load, then enables the switches", async () => {
  state.overrides = ["voice"];
  await act(async () => root.unmount());
  // A first open: nothing loaded yet.
  queryClient.clear();
  root = createRoot(container);
  state.rpc.mockImplementationOnce(async () => {
    throw new Error("offline");
  });
  await render();
  expect(container.textContent).toContain("Something went wrong. Try again.");
  expect(control("Customize Voice")?.disabled).toBe(true);

  await act(async () => retry()!.click());
  await act(flush);
  expect(control("Customize Voice")?.disabled).toBe(false);
  expect(control("Customize Voice")?.checked).toBe(true);
  expect(retry()).toBeUndefined();
  expect(container.textContent).not.toContain("Something went wrong. Try again.");
});

it("keeps a failed save's error when a read that was pending then succeeds", async () => {
  const base = state.rpc.getMockImplementation()!;
  let finishRead!: Deferred;
  state.rpc.mockImplementation(async (proc: string, input?: Record<string, unknown>) => {
    if (proc === "spaceSettings/setOverride") throw new Error("offline");
    if (proc === "spaceSettings/overrides") {
      finishRead = deferred();
      await finishRead.promise;
    }
    return base(proc, input);
  });
  state.focusCount += 1;
  await render();

  await press(control("Customize Models")!);
  expect(container.textContent).toContain("Could not save that preference");

  await act(async () => finishRead.resolve());
  expect(container.textContent).toContain("Could not save that preference");
});

it("keeps a saved setting, with no save error, when the next read fails", async () => {
  await press(control("Customize Voice")!);
  expect(control("Customize Voice")?.checked).toBe(true);

  const base = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation(async (proc: string, input?: Record<string, unknown>) => {
    if (proc === "spaceSettings/overrides") throw new Error("offline");
    return base(proc, input);
  });
  state.focusCount += 1;
  await render();
  expect(control("Customize Voice")?.checked).toBe(true);
  expect(control("Customize Voice")?.disabled).toBe(false);
  expect(container.textContent).toContain("Something went wrong. Try again.");
  expect(container.textContent).not.toContain("Could not save that preference");
});

/** Holds the save open, so a test decides when and how it ends. */
function holdSave() {
  const base = state.rpc.getMockImplementation()!;
  let finish!: (outcome?: Error) => void;
  state.rpc.mockImplementation((proc: string, input?: Record<string, unknown>) =>
    proc === "spaceSettings/setOverride"
      ? new Promise((resolve, reject) => {
          finish = (outcome) => (outcome ? reject(outcome) : resolve(base(proc, input)));
        })
      : base(proc, input),
  );
  const saves = () =>
    state.rpc.mock.calls.filter(([proc]) => proc === "spaceSettings/setOverride").length;
  return { finish: (outcome?: Error) => finish(outcome), saves };
}

it("does not start a second save while one runs", async () => {
  const save = holdSave();
  await press(control("Customize Models")!);
  for (const name of ["Models", "Voice", "Approvals", "Vault"]) {
    expect(control(`Customize ${name}`)?.disabled).toBe(true);
    await press(control(`Customize ${name}`)!);
  }
  expect(save.saves()).toBe(1);

  await act(async () => save.finish());
  expect(control("Customize Models")?.checked).toBe(true);
  expect(control("Customize Voice")?.disabled).toBe(false);
});

it("opens nothing when the save ends after the screen has gone", async () => {
  const save = holdSave();
  await press(control("Customize Models")!);
  await act(async () => root.render(createElement("div")));
  await act(async () => save.finish());
  expect(state.push).not.toHaveBeenCalled();

  // The Space's list is its own, so the answer is still kept for the next visit.
  await render();
  expect(control("Customize Models")?.checked).toBe(true);
});

it("runs one save, and opens its screen, when two switches are tapped in the same tick", async () => {
  const save = holdSave();
  await act(async () => {
    control("Customize Models")!.click();
    control("Customize Voice")!.click();
  });
  expect(save.saves()).toBe(1);
  await act(async () => save.finish());
  expect(state.push.mock.calls).toEqual([
    [{ pathname: "/models", params: { spaceId: "space-other" } }],
  ]);
  expect(control("Customize Models")?.checked).toBe(true);
  expect(control("Customize Voice")?.checked).toBe(false);
});

it.each([
  ["succeeds", undefined],
  ["fails", new Error("offline")],
])(
  "holds the switches for a save that %s after another space was selected, and shows how it ended",
  async (_how, outcome) => {
    const save = holdSave();
    await press(control("Customize Models")!);
    state.selectedSpace = "space-elsewhere";
    await render();
    for (const name of ["Models", "Voice", "Approvals", "Vault"]) {
      expect(control(`Customize ${name}`)?.disabled).toBe(true);
      await press(control(`Customize ${name}`)!);
    }
    expect(save.saves()).toBe(1);

    await act(async () => save.finish(outcome));
    expect(control("Customize Voice")?.disabled).toBe(false);
    if (outcome) {
      expect(container.textContent).toContain("Could not save that preference");
      expect(state.push).not.toHaveBeenCalled();
    } else {
      expect(state.push.mock.calls).toEqual([
        [{ pathname: "/models", params: { spaceId: "space-other" } }],
      ]);
    }
  },
);
