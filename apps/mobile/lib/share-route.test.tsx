// @vitest-environment jsdom
import {
  PreventRemovalProvider,
  RemovalPreventionProvider,
  useRoutesWithRemovalPrevented,
} from "expo-router/build/global-state/removalPrevention";
import { NavigationContext } from "expo-router/build/react-navigation/core/NavigationContext";
import type { NavigationAction } from "expo-router/build/react-navigation/routers/types";
import type { ComponentProps, ReactNode } from "react";
import { act, createElement, useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  pending: { text: "https://example.com", files: [], arrivedAt: 0, generation: 1 } as unknown,
  cancel: vi.fn(),
  dismissTo: vi.fn(),
  reset: vi.fn(),
  prevented: new Set<string>() as ReadonlySet<string>,
  listener: undefined as undefined | ((event: { data: { action: NavigationAction } }) => void),
  reportBlocked: undefined as undefined | ((action: NavigationAction) => void),
}));
// Dispatch reads the committed prevention registry, as the navigation reducer does.
// Disabling prevention schedules a React update; it cannot affect a same-tick dispatch.
const dispatch = (action: NavigationAction) => {
  if (state.prevented.has("share")) state.reportBlocked?.(action);
  else state.reset(action);
};
const router = {
  dismissTo: (path: string) => {
    if (state.prevented.has("share"))
      state.reportBlocked?.({ type: "POP_TO", payload: { name: "index" } });
    else state.dismissTo(path);
  },
};
const navigation = {
  dispatch,
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
  return { useRouter: () => router, useNavigation: () => navigation, usePreventRemove };
});

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
vi.mock("./incoming-share", () => ({
  getIncomingShare: () => state.pending,
  subscribeIncomingShare: () => () => {},
  cancelIncomingShare: state.cancel,
}));
vi.mock("./native", () => ({ useMobileTokens: () => ({}) }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0 }) }));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  View: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  Text: ({ children }: { children: ReactNode }) => createElement("span", null, children),
  Image: () => null,
}));
vi.mock("../components/glass-icon-button", () => ({
  GlassIconButton: ({ onPress }: { onPress: () => void }) =>
    createElement("button", { type: "button", onClick: onPress }, "Close"),
}));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("../app/index", () => ({
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

import ShareRoute from "../app/share";

const container = document.createElement("div");
let root: ReturnType<typeof createRoot>;
async function render() {
  root = createRoot(container);
  await act(async () =>
    root.render(createElement(RemovalPreventionProvider, null, createElement(NavigationHarness))),
  );
}
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  await act(async () => root?.unmount());
  state.pending = { text: "https://example.com", files: [], arrivedAt: 0, generation: 1 };
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
describe("share route", () => {
  it("returns safely to the inbox when the share is absent or expired", async () => {
    state.pending = null;
    await render();
    expect(state.dismissTo).toHaveBeenCalledWith("/");
  });
  it("clears the pending share on close and returns to the inbox", async () => {
    await render();
    await act(async () => container.querySelector("button")?.click());
    expect(state.cancel).toHaveBeenCalledOnce();
    expect(state.dismissTo).toHaveBeenCalledWith("/");
  });
  it("preserves the pending share while redirecting to sign-in", async () => {
    await render();
    expect(state.prevented.has("share")).toBe(true);
    await act(async () => dispatch({ type: "REPLACE", payload: { name: "sign-in" } }));
    expect(state.reset).toHaveBeenCalledExactlyOnceWith({
      type: "REPLACE",
      payload: { name: "sign-in" },
    });
    expect(state.prevented.has("share")).toBe(false);
    expect(state.cancel).not.toHaveBeenCalled();
    expect(state.dismissTo).not.toHaveBeenCalled();
  });
  it("cancels on native back or dismissal", async () => {
    await render();
    await act(async () => dispatch({ type: "GO_BACK" }));
    expect(state.reset).not.toHaveBeenCalled();
    expect(state.cancel).toHaveBeenCalledOnce();
    expect(state.dismissTo).toHaveBeenCalledWith("/");
  });
  it.each([
    { text: "https://example.com", files: [] },
    {
      text: "",
      files: [
        { uri: "file:///shared/example.pdf", name: "example.pdf", mimeType: "application/pdf" },
      ],
    },
  ])("opens the selected thread with the pending share intact: %j", async (content) => {
    const share = { ...content, arrivedAt: 0, generation: 1 };
    state.pending = share;
    await render();
    await act(async () => container.querySelectorAll("button")[1]?.click());
    expect(state.prevented.has("share")).toBe(false);
    expect(state.cancel).not.toHaveBeenCalled();
    expect(state.dismissTo).not.toHaveBeenCalled();
    expect(state.pending).toBe(share);
    expect(state.reset).toHaveBeenCalledExactlyOnceWith({
      type: "RESET",
      payload: {
        index: 1,
        routes: [{ name: "index" }, { name: "thread", params: { botId: "example", name: "Bot" } }],
      },
    });
  });
  it("ignores a second selection before leaving the picker", async () => {
    await render();
    await act(async () => {
      container.querySelectorAll("button")[1]?.click();
      container.querySelectorAll("button")[1]?.click();
    });
    expect(state.reset).toHaveBeenCalledOnce();
    expect(state.cancel).not.toHaveBeenCalled();
  });
});
