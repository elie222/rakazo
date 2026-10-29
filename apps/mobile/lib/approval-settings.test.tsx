// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApprovalModeRow } from "../components/approval-settings-rows";
import { useApprovalSettings } from "./approval-settings";
import type { SettingsTarget } from "./settings-target";
import { ACCOUNT_SETTINGS } from "./settings-target";

type Settings = {
  mode: string;
  enabled: boolean;
  skipApprovals: boolean;
  checkerAvailable: boolean;
};
const state = vi.hoisted(() => ({
  rpc: vi.fn(),
  alert: vi.fn(),
  settings: {} as Settings,
  rules: [] as unknown[],
  refocus: () => undefined as unknown,
}));
const { element } = vi.hoisted(() => ({
  element:
    (tag: string) =>
    ({ children }: { children?: ReactNode }) =>
      createElement(tag, null, children),
}));

vi.mock("./native", () => ({
  native: {},
  useResolvedAppearance: () => "light",
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
  useFocusEffect: (effect: () => undefined | (() => void)) => {
    state.refocus = effect;
    useEffect(effect, [effect]);
  },
}));
vi.mock("react-native", () => ({
  Alert: { alert: state.alert },
  StyleSheet: { create: <T,>(styles: T) => styles },
  View: element("div"),
}));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("@expo/ui/community/menu", () => ({
  MenuView: ({
    actions,
    onPressAction,
    title,
    children,
  }: {
    actions: { id: string; title: string; state?: string; attributes?: { disabled?: boolean } }[];
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
            disabled: action.attributes?.disabled,
            "aria-pressed": action.state === "on",
            onClick: () => onPressAction({ nativeEvent: { event: action.id } }),
          },
          action.title,
        ),
      ),
    ),
}));
vi.mock("../components/settings-group", () => ({
  SettingsRow: ({
    title,
    value,
    detail,
    accessibilityLabel,
    accessibilityValue,
    accessibilityHint,
    accessibilityState,
    onPress,
  }: {
    accessibilityState?: { disabled?: boolean };
    onPress?: () => void;
    title: string;
    value?: string;
    detail?: string;
    accessibilityLabel?: string;
    accessibilityValue?: { text?: string };
    accessibilityHint?: string;
  }) =>
    createElement(
      "span",
      {
        "data-spoken": [accessibilityLabel, accessibilityValue?.text, accessibilityHint]
          .filter(Boolean)
          .join(", "),
        "data-disabled": accessibilityState?.disabled,
        onClick: onPress,
      },
      [title, value, detail].filter(Boolean).join(" | "),
    ),
}));

let root: Root;
let container: HTMLDivElement;
const row = () => container.querySelector("span")?.textContent;
const spoken = () => container.querySelector("span")?.getAttribute("data-spoken");
const choices = () =>
  [...container.querySelectorAll('[aria-label="Approvals"] button')].map(
    (node) => `${node.textContent}${node.getAttribute("aria-pressed") === "true" ? "*" : ""}`,
  );
const choice = (label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('[aria-label="Approvals"] button')].find(
    (node) => node.textContent === label,
  )!;
const sets = () => state.rpc.mock.calls.filter(([proc]) => proc === "autoReview/set");
const reads = () => state.rpc.mock.calls.filter(([proc]) => proc === "autoReview/get").length;
const held = () => container.querySelector("span")?.getAttribute("data-disabled");
// Holds every save's reply until `finish` is called, storing it then or, with `storedAtOnce`, when
// sent. Holds every read while `holdReads` is set; a held read answers with what was stored when it
// started, as the server would.
function slowSaves({ storedAtOnce = false } = {}) {
  const base = state.rpc.getMockImplementation()!;
  const control = {
    finish: () => undefined as unknown,
    holdReads: false,
    reads: [] as (() => void)[],
  };
  state.rpc.mockImplementation((proc: string, input?: Record<string, unknown>) => {
    if (proc === "autoReview/set") {
      const stored = storedAtOnce ? base(proc, input) : null;
      return new Promise((resolve) => {
        control.finish = () => resolve(stored ?? base(proc, input));
      });
    }
    if (proc === "autoReview/get" && control.holdReads) {
      const stored = { ...state.settings };
      return new Promise((resolve) => control.reads.push(() => resolve(stored)));
    }
    return base(proc, input);
  });
  return control;
}

function Harness({ target, enabled }: { target: SettingsTarget; enabled?: boolean }) {
  const approvals = useApprovalSettings(target, enabled);
  return createElement(
    "div",
    null,
    createElement(ApprovalModeRow, { approvals }),
    createElement("output", null, approvals.ruleCount),
  );
}

async function render(target: SettingsTarget = ACCOUNT_SETTINGS, enabled?: boolean) {
  await act(async () => root.render(createElement(Harness, { target, enabled })));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.settings = { mode: "ask", enabled: false, skipApprovals: false, checkerAvailable: false };
  state.rules = [];
  state.alert.mockReset();
  state.rpc
    .mockReset()
    .mockImplementation(async (proc: string, input?: Record<string, unknown>) => {
      if (proc === "autoReview/get") return state.settings;
      if (proc === "autoReview/set") {
        state.settings = { ...state.settings, mode: input!.mode as string };
        return state.settings;
      }
      if (proc === "approvalRules/list") return state.rules;
      throw new Error(`Unexpected RPC: ${proc}`);
    });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("shows the mode as the row's value and saves a pick from the menu at once", async () => {
  await render();
  expect(row()).toBe("Approvals | Ask");
  // Named outright, so the menu symbol beside the value isn't read out.
  expect(spoken()).toBe("Approvals, Ask");
  expect(choices()).toEqual(["Never ask", "Ask*"]);

  await act(async () => choice("Never ask").click());
  expect(sets()).toEqual([["autoReview/set", { scope: "account", mode: "never" }]]);
  expect(row()).toBe("Approvals | Never ask");
  expect(choices()).toEqual(["Never ask*", "Ask"]);

  // Picking the current mode saves nothing.
  await act(async () => choice("Never ask").click());
  expect(sets()).toHaveLength(1);
});

it("offers Auto only once an approval model can decide, and explains a chosen Auto without one", async () => {
  state.settings = { ...state.settings, checkerAvailable: true };
  await render();
  expect(choices()).toEqual(["Never ask", "Auto", "Ask*"]);

  act(() => root.unmount());
  root = createRoot(container);
  state.settings = { ...state.settings, mode: "auto", checkerAvailable: false };
  await render();
  expect(choices()).toEqual(["Never ask", "Auto*", "Ask"]);
  expect(row()).toBe("Approvals | Auto | Add a model in Settings to use this.");
  expect(spoken()).toBe("Approvals, Auto, Add a model in Settings to use this.");
});

it("offers a retry in the row when the first load fails", async () => {
  state.rpc.mockImplementationOnce(async () => {
    throw new Error("offline");
  });
  await render();
  expect(row()).toBe("Approvals | Retry | Something went wrong. Try again.");
  expect(choices()).toEqual([]);

  await act(async () => container.querySelector("span")!.click());
  expect(row()).toBe("Approvals | Ask");
  expect(choices()).toEqual(["Never ask", "Ask*"]);
});

it("goes back to the stored mode and alerts when a save fails", async () => {
  await render();
  const base = state.rpc.getMockImplementation()!;
  let stored: string | null = null;
  let finishRead: () => void = () => undefined;
  state.rpc.mockImplementation(async (proc: string, input?: Record<string, unknown>) => {
    if (proc === "autoReview/set") throw new Error("offline");
    if (proc === "autoReview/get") {
      await new Promise<void>((resolve) => {
        finishRead = resolve;
      });
      if (!stored) throw new Error("offline");
      return { ...state.settings, mode: stored };
    }
    return base(proc, input);
  });

  await act(async () => choice("Never ask").click());
  expect(state.alert).toHaveBeenCalledWith("Could not save that preference", "Try again.");
  expect(row()).toBe("Approvals | Ask");
  expect(choices()).toEqual(["Never ask", "Ask*"]);
  // If what is stored can't be read either, the row shows no mode and offers to read it again.
  await act(async () => finishRead());
  expect(row()).toBe("Approvals | Retry | Something went wrong. Try again.");
  expect(choices()).toEqual([]);

  // A save that landed before its reply was lost shows as saved.
  stored = "never";
  await act(async () => container.querySelector("span")!.click());
  await act(async () => finishRead());
  expect(row()).toBe("Approvals | Never ask");
});

it("shows the saved mode when a read started during the save lands after it", async () => {
  await render();
  const slow = slowSaves();
  await act(async () => choice("Never ask").click());

  // Back from the rules list mid-save: a read then would answer with the mode being replaced.
  slow.holdReads = true;
  await act(async () => state.refocus());
  await act(async () => slow.finish());
  for (const read of slow.reads.splice(0)) await act(async () => read());
  expect(row()).toBe("Approvals | Never ask");
  // It reads again once the save is done, so the rule count is fresh too.
  expect(reads()).toBe(2);
});

it("drops a save that lands after the Space went back to following the account", async () => {
  const target: SettingsTarget = { scope: "space", spaceId: "space-1" };
  await render(target, true);
  const slow = slowSaves({ storedAtOnce: true });
  await act(async () => choice("Never ask").click());

  // Customizing is turned off and on again before the reply comes back; the Space starts again
  // from the account's mode.
  await render(target, false);
  state.settings = { ...state.settings, mode: "ask" };
  await render(target, true);
  await act(async () => slow.finish());
  expect(row()).toBe("Approvals | Ask");
});

it("tells screen readers the row is unavailable while loading or saving", async () => {
  const slow = slowSaves();
  slow.holdReads = true;
  await render();
  expect(held()).toBe("true");
  slow.holdReads = false;
  await act(async () => slow.reads.splice(0)[0]!());
  expect(held()).toBe("false");

  await act(async () => choice("Never ask").click());
  expect(held()).toBe("true");
  await act(async () => slow.finish());
  expect(held()).toBe("false");
});

it("offers a retry when a refresh fails after the mode loaded", async () => {
  await render();
  state.rpc.mockImplementationOnce(async () => {
    throw new Error("offline");
  });
  await act(async () => state.refocus());
  expect(row()).toBe("Approvals | Retry | Something went wrong. Try again.");

  await act(async () => container.querySelector("span")!.click());
  expect(row()).toBe("Approvals | Ask");
});

it("holds the menu while a save is in flight", async () => {
  const base = state.rpc.getMockImplementation()!;
  let finish: () => void = () => undefined;
  state.rpc.mockImplementation((proc: string, input?: Record<string, unknown>) =>
    proc === "autoReview/set"
      ? new Promise((resolve) => {
          finish = () => resolve(base(proc, input));
        })
      : base(proc, input),
  );
  await render();
  await act(async () => choice("Never ask").click());
  expect(choice("Ask").disabled).toBe(true);
  await act(async () => choice("Ask").click());
  expect(sets()).toHaveLength(1);

  await act(async () => finish());
  // Two picks in the same frame, before the menu re-renders as held, still save once.
  await act(async () => {
    choice("Ask").click();
    choice("Ask").click();
  });
  expect(sets()).toHaveLength(2);

  await act(async () => finish());
  expect(row()).toBe("Approvals | Ask");
  expect(choice("Never ask").disabled).toBe(false);
});

it("keeps a saved mode when a read that started before the save lands after it", async () => {
  await render();
  const base = state.rpc.getMockImplementation()!;
  let resolveRead: (value: Settings) => void = () => undefined;
  state.rpc.mockImplementation(async (proc: string, input?: Record<string, unknown>) =>
    proc === "autoReview/get"
      ? new Promise((resolve) => {
          resolveRead = resolve;
        })
      : base(proc, input),
  );
  const stale = { ...state.settings };

  // Coming back starts a refresh; the owner picks Never ask before it lands with the old mode.
  state.rules = [{ id: "rule-1" }];
  await act(async () => state.refocus());
  await act(async () => choice("Never ask").click());
  await act(async () => resolveRead(stale));
  expect(row()).toBe("Approvals | Never ask");
  // The rules it read are still current, so the count follows them.
  expect(container.querySelector("output")?.textContent).toBe("1");
});

it.each(["autoReview/get", "approvalRules/list"])(
  "keeps the saved mode when an older %s refresh fails",
  async (failedProc) => {
    await render();
    const base = state.rpc.getMockImplementation()!;
    let rejectRead: (reason: Error) => void = () => undefined;
    state.rpc.mockImplementation((proc: string, input?: Record<string, unknown>) =>
      proc === failedProc
        ? new Promise((_, reject) => {
            rejectRead = reject;
          })
        : base(proc, input),
    );

    await act(async () => state.refocus());
    await act(async () => choice("Never ask").click());
    expect(state.settings.mode).toBe("never");
    expect(row()).toBe("Approvals | Never ask");
    await act(async () => rejectRead(new Error("offline")));
    expect(row()).toBe("Approvals | Never ask");
    expect(choices()).toEqual(["Never ask*", "Ask"]);
  },
);

it("ignores an older refresh failure while a save is pending", async () => {
  await render();
  const slow = slowSaves();
  const base = state.rpc.getMockImplementation()!;
  let rejectRead: (reason: Error) => void = () => undefined;
  state.rpc.mockImplementation((proc: string, input?: Record<string, unknown>) =>
    proc === "autoReview/get"
      ? new Promise((_, reject) => {
          rejectRead = reject;
        })
      : base(proc, input),
  );

  await act(async () => state.refocus());
  await act(async () => choice("Never ask").click());
  await act(async () => rejectRead(new Error("offline")));
  expect(row()).toBe("Approvals | Never ask");
  expect(held()).toBe("true");
  await act(async () => slow.finish());
  expect(state.settings.mode).toBe("never");
  expect(row()).toBe("Approvals | Never ask");
});

it("shows a refresh failure from a read started after a successful save", async () => {
  await render();
  await act(async () => choice("Never ask").click());
  state.rpc.mockImplementationOnce(async () => {
    throw new Error("offline");
  });
  await act(async () => state.refocus());
  expect(row()).toBe("Approvals | Retry | Something went wrong. Try again.");
  await act(async () => container.querySelector("span")!.click());
  expect(row()).toBe("Approvals | Never ask");
});

it("reads and saves a Space's own copy, and nothing while the Space follows the account", async () => {
  const spaceContext = { requestContext: { headers: { space: "space-1" } } };
  const target: SettingsTarget = { scope: "space", spaceId: "space-1" };
  await render(target, false);
  expect(state.rpc).not.toHaveBeenCalled();
  expect(row()).toBe("Approvals");

  await render(target, true);
  expect(state.rpc).toHaveBeenCalledWith("autoReview/get", { scope: "space" }, spaceContext);
  expect(state.rpc).toHaveBeenCalledWith("approvalRules/list", { scope: "space" }, spaceContext);
  await act(async () => choice("Never ask").click());
  expect(sets()).toEqual([["autoReview/set", { scope: "space", mode: "never" }, spaceContext]]);
});
