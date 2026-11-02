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
  verifyOwner: vi.fn(),
  generation: 1,
  params: {} as { botId?: string; spaceId?: string; userId?: string },
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
  StyleSheet: { create: (styles: unknown) => styles },
  Text: element("span"),
  View: element("div"),
}));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({ label, onPress }: { label: string; onPress: () => void }) =>
    createElement("button", { type: "button", onClick: onPress }, label),
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
vi.mock("./appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("./native", () => ({
  useMobileTokens: () => ({}),
  useThemedStyles: (create: () => unknown) => create(),
}));
vi.mock("./session", () => ({
  currentReadySessionGeneration: () => state.generation,
  currentSessionGeneration: () => state.generation,
  subscribeSessionGeneration: () => () => undefined,
  loadVerifiedIntegrationsScope: state.verifyOwner,
}));
vi.mock("./user-error", () => ({ errorText: () => "error" }));

import ThreadRoute from "../app/thread";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.selected = "space-1";
  state.params = {};
  state.generation = 1;
  state.verifyOwner.mockReset().mockResolvedValue({
    apiBase: "https://app.example.test",
    userId: "user-1",
  });
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

it("never mounts a thread when its notification belongs to another account", async () => {
  state.params = { botId: "bot-1", userId: "other-user", spaceId: "other-space" };
  await render();
  expect(container.textContent).toContain("Sign in to open this notification");
  expect(container.textContent).not.toContain("thread:");
  expect(state.selectSpace).not.toHaveBeenCalled();
  act(() => container.querySelector("button")?.click());
  expect(state.replace).toHaveBeenCalledWith({
    pathname: "/notification-open",
    params: { target: "rakazo://thread?botId=bot-1&userId=other-user&spaceId=other-space" },
  });
});

it("waits for notification ownership before switching spaces or showing recovery", async () => {
  state.params = { userId: "user-1", spaceId: "space-2" };
  let verify!: (value: { apiBase: string; userId: string }) => void;
  state.verifyOwner.mockReturnValue(
    new Promise((resolve) => {
      verify = resolve;
    }),
  );
  state.selectSpace.mockImplementation(async (spaceId: string) => {
    state.selected = spaceId;
    return true;
  });
  await render();
  expect(container.querySelector("progress")).not.toBeNull();
  expect(container.textContent).not.toContain("Sign in");
  expect(container.textContent).not.toContain("thread:");
  expect(state.selectSpace).not.toHaveBeenCalled();
  await act(async () => verify({ apiBase: "https://app.example.test", userId: "user-1" }));
  expect(container.textContent).toBe("thread:user-1");
  expect(state.selectSpace).toHaveBeenCalledWith("space-2");
});

it("does not use the previous session's owner while a new session is being verified", async () => {
  await render();
  expect(container.textContent).toBe("thread:user-1");
  state.generation++;
  state.params = { userId: "user-2", spaceId: "space-2" };
  let verify!: (value: { apiBase: string; userId: string }) => void;
  state.verifyOwner.mockReturnValue(
    new Promise((resolve) => {
      verify = resolve;
    }),
  );
  await render();
  expect(container.querySelector("progress")).not.toBeNull();
  expect(container.textContent).not.toContain("Sign in");
  expect(container.textContent).not.toContain("thread:");
  expect(state.selectSpace).not.toHaveBeenCalled();
  await act(async () => verify({ apiBase: "https://app.example.test", userId: "other-user" }));
  expect(container.textContent).toContain("Sign in to open this notification");
  expect(container.textContent).not.toContain("thread:");
  expect(state.selectSpace).not.toHaveBeenCalled();
});
