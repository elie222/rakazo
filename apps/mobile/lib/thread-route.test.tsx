// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  selected: "space-1" as string | null,
  selectSpace: vi.fn(),
  replace: vi.fn(),
  params: {} as { spaceId?: string },
}));

const { element } = vi.hoisted(() => ({
  element:
    (tag: string) =>
    ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) =>
      createElement(tag, onPress ? { onClick: onPress } : null, children),
}));

vi.mock("expo-router", () => ({
  useIsFocused: () => true,
  useLocalSearchParams: () => state.params,
  useRouter: () => ({ replace: state.replace }),
}));
vi.mock("react-native", () => ({
  ActivityIndicator: () => createElement("progress"),
  Alert: { alert: vi.fn() },
  Pressable: element("button"),
  Text: element("span"),
  View: element("div"),
}));
vi.mock("../components/thread/thread-screen", () => ({
  Thread: ({ userId }: { userId: string }) => createElement("main", null, `thread:${userId}`),
}));
vi.mock("./api", () => ({
  currentApiBase: () => "https://app.example.test",
  selectedSpaceId: () => state.selected,
  selectSpace: state.selectSpace,
}));
vi.mock("./i18n", () => {
  const t = (text: string) => text;
  return { t, useI18n: () => ({ t }) };
});
vi.mock("./integrations-cache", () => ({ integrationsCacheScope: () => null }));
vi.mock("./native", () => ({ useMobileTokens: () => ({}) }));
vi.mock("./session", () => ({
  currentReadySessionGeneration: () => 1,
  currentSessionGeneration: () => 1,
  subscribeSessionGeneration: () => () => undefined,
  loadVerifiedIntegrationsScope: async () => ({
    apiBase: "https://app.example.test",
    userId: "user-1",
  }),
}));
vi.mock("./user-error", () => ({ errorText: () => "error" }));

import ThreadRoute from "../app/thread";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.selected = "space-1";
  state.params = {};
  state.selectSpace.mockReset();
  state.replace.mockReset();
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

const render = () => act(async () => root.render(createElement(ThreadRoute)));

it("switches to the requested space before showing the thread", async () => {
  state.params = { spaceId: "space-2" };
  state.selectSpace.mockImplementation(async (spaceId: string) => {
    state.selected = spaceId;
    return true;
  });
  await render();
  expect(state.selectSpace).toHaveBeenCalledWith("space-2");
  expect(container.textContent).toBe("thread:user-1");
});

it("offers a way back when the space switch fails or is rolled back", async () => {
  state.params = { spaceId: "space-2" };
  // selectSpace reports success but a failed write rolled the selection back.
  state.selectSpace.mockResolvedValue(true);
  await render();
  expect(container.textContent).toContain("Could not switch spaces");
  expect(container.textContent).not.toContain("thread:");
  act(() => container.querySelector("button")?.click());
  expect(state.replace).toHaveBeenCalledWith("/");
});

it("shows the thread without switching when no space is requested", async () => {
  await render();
  expect(state.selectSpace).not.toHaveBeenCalled();
  expect(container.textContent).toBe("thread:user-1");
});
