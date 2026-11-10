// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  pending: { text: "https://example.com", files: [], arrivedAt: 0, generation: 1 } as unknown,
  cancel: vi.fn(),
  dismissTo: vi.fn(),
  reset: vi.fn(),
  allowRemoval: vi.fn(),
  guarded: false,
  blocked: undefined as
    | undefined
    | ((event: { data: { action: { payload?: { name: string } } }; repeat: () => void }) => void),
}));
const router = { dismissTo: state.dismissTo };
const navigation = { dispatch: state.reset };
vi.mock("expo-router", () => ({
  useRouter: () => router,
  useNavigation: () => navigation,
  usePreventRemove: (guarded: boolean, blocked: typeof state.blocked) => {
    state.guarded = guarded;
    state.blocked = blocked;
    return state.allowRemoval;
  },
}));
vi.mock("./incoming-share", () => ({
  getIncomingShare: () => state.pending,
  subscribeIncomingShare: () => () => {},
  cancelIncomingShare: state.cancel,
}));
vi.mock("./native", () => ({ useMobileTokens: () => ({}) }));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0 }) }));
vi.mock("react-native", () => ({
  Platform: { OS: "android" },
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
  await act(async () => root.render(createElement(ShareRoute)));
}
afterEach(async () => {
  await act(async () => root?.unmount());
  state.pending = { text: "https://example.com", files: [], arrivedAt: 0, generation: 1 };
  vi.clearAllMocks();
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
    expect(state.guarded).toBe(true);
    const repeat = vi.fn();
    await act(async () =>
      state.blocked?.({ data: { action: { payload: { name: "sign-in" } } }, repeat }),
    );
    expect(repeat).toHaveBeenCalledOnce();
    expect(state.allowRemoval).toHaveBeenCalledOnce();
    expect(state.guarded).toBe(false);
    expect(state.cancel).not.toHaveBeenCalled();
    expect(state.dismissTo).not.toHaveBeenCalled();
  });
  it("cancels on native back or dismissal", async () => {
    await render();
    const repeat = vi.fn();
    await act(async () => state.blocked?.({ data: { action: {} }, repeat }));
    expect(repeat).not.toHaveBeenCalled();
    expect(state.allowRemoval).toHaveBeenCalledOnce();
    expect(state.cancel).toHaveBeenCalledOnce();
    expect(state.dismissTo).toHaveBeenCalledWith("/");
  });
  it("preserves the share for the selected thread and removes the target screen", async () => {
    await render();
    await act(async () => container.querySelectorAll("button")[1]?.click());
    expect(state.guarded).toBe(false);
    expect(state.allowRemoval).toHaveBeenCalledOnce();
    expect(state.cancel).not.toHaveBeenCalled();
    expect(state.dismissTo).not.toHaveBeenCalled();
    expect(state.reset).toHaveBeenCalledWith({
      type: "RESET",
      payload: {
        index: 1,
        routes: [{ name: "index" }, { name: "thread", params: { botId: "example", name: "Bot" } }],
      },
    });
  });
});
