// @vitest-environment jsdom
import {
  PreventRemovalProvider,
  RemovalPreventionProvider,
  useRoutesWithRemovalPrevented,
} from "expo-router/build/global-state/removalPrevention";
import { NavigationContext } from "expo-router/build/react-navigation/core/NavigationContext";
import type { StackNavigationState } from "expo-router/build/react-navigation/routers/StackRouter";
import { StackRouter } from "expo-router/build/react-navigation/routers/StackRouter";
import type {
  NavigationAction,
  ParamListBase,
} from "expo-router/build/react-navigation/routers/types";
import type { ComponentProps, ReactNode } from "react";
import { act, createElement, useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  const releaseChoice = vi.fn();
  return {
    pending: { text: "https://example.com", files: [], arrivedAt: 0, generation: 1 } as unknown,
    cancel: vi.fn(),
    choose: vi.fn(() => releaseChoice),
    releaseChoice,
    breadcrumb: vi.fn(),
    report: vi.fn(),
    dropNextAction: false,
    protect: new Set<string>(),
    prevented: new Set<string>() as ReadonlySet<string>,
    listener: undefined as undefined | ((event: { data: { action: NavigationAction } }) => void),
    reportBlocked: undefined as undefined | ((action: NavigationAction) => void),
  };
});
const stackRouter = StackRouter({ initialRouteName: "index" });
const config = {
  routeNames: ["index", "note", "share", "thread", "sign-in"],
  routeParamList: {},
  routeGetIdList: {},
};
let stack: StackNavigationState<ParamListBase>;
function shareOnStack(...under: string[]) {
  const names = [...under, "share"];
  stack = {
    stale: false,
    type: "stack",
    key: "app-stack",
    routeNames: config.routeNames,
    index: names.length - 1,
    routeKeySeq: names.length,
    routes: names.map((name) => ({ name, key: name })),
  };
}
// Dispatch reads the committed prevention registry, as the navigation reducer does.
// Disabling prevention schedules a React update; it cannot affect a same-tick dispatch.
const dispatch = (action: NavigationAction) => {
  if (state.dropNextAction) {
    state.dropNextAction = false;
    return;
  }
  const result = stackRouter.getStateForAction(
    stack,
    action as Parameters<typeof stackRouter.getStateForAction>[1],
    config,
  );
  if (!result || typeof result === "string") return;
  const removed = stack.routes.filter(
    (route) => !result.state.routes.some((next) => next.key === route.key),
  );
  if (removed.some((route) => state.protect.has(route.key))) return;
  if (removed.some((route) => state.prevented.has(route.key))) state.reportBlocked?.(action);
  else stack = result.state;
};
const navigation = {
  dispatch: (action: NavigationAction) => dispatch({ source: "share", ...action }),
  getState: () => stack,
  isFocused: () => stack.routes[stack.index]?.name === "share",
  addListener: (_type: string, listener: typeof state.listener) => {
    state.listener = listener;
    return () => {
      state.listener = undefined;
    };
  },
};
vi.mock("expo-router", async () => {
  const { usePreventRemove } = await import(
    "expo-router/build/react-navigation/core/usePreventRemove"
  );
  return {
    useIsFocused: () => navigation.isFocused(),
    useNavigation: () => navigation,
    usePreventRemove,
  };
});
vi.mock(
  "expo-router/react-navigation",
  () => import("expo-router/build/react-navigation/routers/StackRouter"),
);

function NavigationHarness() {
  state.prevented = useRoutesWithRemovalPrevented();
  const [blocked, setBlocked] = useState<NavigationAction>();
  state.reportBlocked = setBlocked;
  // Expo Router delivers removePrevented after the navigation report commits.
  useLayoutEffect(() => {
    if (blocked) state.listener?.({ data: { action: blocked } });
  }, [blocked]);
  return (
    <NavigationContext.Provider
      value={navigation as unknown as ComponentProps<typeof NavigationContext.Provider>["value"]}
    >
      <PreventRemovalProvider routeKey="share">
        <ShareRoute />
      </PreventRemovalProvider>
    </NavigationContext.Provider>
  );
}
vi.mock("../composer/incoming-share", () => ({
  getIncomingShare: () => state.pending,
  subscribeIncomingShare: () => () => {},
  cancelIncomingShare: state.cancel,
  chooseIncomingShareThread: state.choose,
}));
vi.mock("../native/native", () => ({ useMobileTokens: () => ({}) }));
vi.mock("../platform/monitoring", () => ({
  recordMobileShareAction: state.breadcrumb,
  reportMobileError: state.report,
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0 }) }));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  View: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  Text: ({ children }: { children: ReactNode }) => createElement("span", null, children),
  Image: () => null,
}));
vi.mock("../../components/native/glass-icon-button", () => ({
  GlassIconButton: ({ onPress }: { onPress: () => void }) =>
    createElement("button", { type: "button", onClick: onPress }, "Close"),
}));
vi.mock("../../components/native/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("../../app/index", () => ({
  HomeSession: ({
    onShareSelect,
  }: {
    onShareSelect: (bot: { id: string; name: string }) => void;
  }) =>
    createElement(
      "button",
      { type: "button", onClick: () => onShareSelect({ id: "example", name: "Bot" }) },
      "Chat",
    ),
}));

import ShareRoute from "../../app/share";

const container = document.createElement("div");
let root: ReturnType<typeof createRoot>;
async function render() {
  root = createRoot(container);
  await act(async () =>
    root.render(createElement(RemovalPreventionProvider, null, createElement(NavigationHarness))),
  );
}
const routeNames = () => stack.routes.map((route) => route.name);
const click = (index: number) => container.querySelectorAll("button")[index]?.click();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  shareOnStack("index");
});
afterEach(async () => {
  await act(async () => root?.unmount());
  state.pending = { text: "https://example.com", files: [], arrivedAt: 0, generation: 1 };
  state.protect.clear();
  state.dropNextAction = false;
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
describe("share route", () => {
  it("returns safely to the inbox when the share is absent or expired", async () => {
    state.pending = null;
    shareOnStack();
    await render();
    expect(routeNames()).toEqual(["index"]);
  });
  it("closes the picker without removing the screen underneath", async () => {
    shareOnStack("index", "note");
    state.protect.add("note");
    await render();
    await act(async () => click(0));
    expect(state.cancel).toHaveBeenCalledOnce();
    expect(routeNames()).toEqual(["index", "note"]);
  });
  it("preserves the pending share while redirecting to sign-in", async () => {
    await render();
    expect(state.prevented.has("share")).toBe(true);
    await act(async () => dispatch({ type: "REPLACE", payload: { name: "sign-in" } }));
    expect(routeNames()).toEqual(["index", "sign-in"]);
    expect(state.prevented.has("share")).toBe(false);
    expect(state.cancel).not.toHaveBeenCalled();
  });
  it("cancels on native back or dismissal", async () => {
    await render();
    await act(async () => dispatch({ type: "GO_BACK" }));
    expect(state.cancel).toHaveBeenCalledOnce();
    expect(routeNames()).toEqual(["index"]);
  });
  it("opens the selected thread while preserving a protected screen and the share", async () => {
    shareOnStack("index", "note");
    state.protect.add("note");
    const share = {
      text: "",
      files: [{ uri: "file:///shared/example.png", name: "example.png", mimeType: "image/png" }],
      arrivedAt: 0,
      generation: 1,
    };
    state.pending = share;
    await render();
    await act(async () => click(1));
    expect(state.prevented.has("share")).toBe(false);
    expect(state.cancel).not.toHaveBeenCalled();
    expect(state.pending).toBe(share);
    expect(state.choose).toHaveBeenCalledExactlyOnceWith("example");
    expect(routeNames()).toEqual(["index", "note", "thread"]);
    expect(stack.routes.at(-1)?.params).toEqual({ botId: "example", name: "Bot" });
  });
  it("reports dropped navigation and lets the user close the picker", async () => {
    vi.useFakeTimers();
    state.dropNextAction = true;
    await render();
    await act(async () => click(1));
    expect(routeNames()).toEqual(["index", "share"]);
    expect(state.breadcrumb).toHaveBeenCalledWith("select");
    await act(async () => vi.runOnlyPendingTimersAsync());
    expect(state.releaseChoice).toHaveBeenCalledOnce();
    expect(state.report).toHaveBeenCalledExactlyOnceWith(expect.any(Error), "mobile.share", {
      screen: "share",
      action: "select",
    });
    await act(async () => click(0));
    expect(routeNames()).toEqual(["index"]);
  });
  it("keeps the choice when navigation succeeded and the picker is still mounted", async () => {
    vi.useFakeTimers();
    await render();
    await act(async () => click(1));
    expect(routeNames()).toEqual(["index", "thread"]);
    await act(async () => vi.runOnlyPendingTimersAsync());
    expect(state.releaseChoice).not.toHaveBeenCalled();
    expect(state.report).not.toHaveBeenCalled();
  });
  it("returns to the existing chat when the picker is above the selected chat", async () => {
    shareOnStack("index", "thread");
    stack.routes[1] = { name: "thread", key: "thread", params: { botId: "example" } };
    await render();
    await act(async () => click(1));
    expect(routeNames()).toEqual(["index", "thread"]);
    expect(stack.routes[1]?.key).toBe("thread");
  });
  it("ignores a second selection before leaving the picker", async () => {
    await render();
    await act(async () => {
      click(1);
      click(1);
    });
    expect(state.choose).toHaveBeenCalledOnce();
    expect(state.cancel).not.toHaveBeenCalled();
  });
});
