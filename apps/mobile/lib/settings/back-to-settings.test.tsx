// @vitest-environment jsdom

import { act, useLayoutEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openFromSettings, useBackToSettings, useRestoreSpaces } from "./back-to-settings";

type Removed = (event: { data: { action: { type: string } } }) => void;

const page = vi.hoisted(() => ({
  fromSettings: undefined as string | undefined,
  platform: { OS: "ios" },
  push: vi.fn(),
  setParams: vi.fn(),
  removed: new Set<Removed>(),
}));

vi.mock("react-native", () => ({ Platform: page.platform }));
vi.mock("expo-router", () => {
  const router = { push: page.push, setParams: page.setParams };
  const navigation = {
    addListener: (name: string, listener: Removed) => {
      if (name !== "removed") throw new Error(`Unexpected listener: ${name}`);
      page.removed.add(listener);
      return () => page.removed.delete(listener);
    },
  };
  return {
    useLocalSearchParams: () => ({ fromSettings: page.fromSettings }),
    useNavigation: () => navigation,
    useRouter: () => router,
  };
});

let root: Root;

function Page() {
  useBackToSettings();
  return null;
}

function Navigator({ action }: { action?: string }) {
  // Expo Router reports the removal in a layout effect in the commit that unmounts the route.
  useLayoutEffect(() => {
    if (action) {
      for (const listener of page.removed) listener({ data: { action: { type: action } } });
    }
  }, [action]);
  return action ? null : <Page />;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  page.platform.OS = "ios";
  page.push.mockReset();
  page.setParams.mockReset();
  root = createRoot(document.createElement("div"));
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

it.each([
  ["POP", "/account", "/account"],
  ["GO_BACK", "/spaces", { pathname: "/account", params: { fromSettings: "/spaces" } }],
] as const)("restores the originating Settings stack on %s", async (action, origin, href) => {
  page.fromSettings = origin;
  await act(async () => root.render(<Navigator />));
  await act(async () => root.render(<Navigator action={action} />));
  expect(page.push).toHaveBeenCalledExactlyOnceWith(href);
  expect(page.removed.size).toBe(0);
});

it("leaves Settings closed when leaving a Space dismisses the stack", async () => {
  page.fromSettings = "/spaces";
  await act(async () => root.render(<Navigator />));
  await act(async () => root.render(<Navigator action="POP_TO_TOP" />));
  expect(page.push).not.toHaveBeenCalled();
});

it("leaves Settings closed when navigation replaces the destination", async () => {
  page.fromSettings = "/account";
  await act(async () => root.render(<Navigator />));
  await act(async () => root.render(<Navigator action="REPLACE" />));
  expect(page.push).not.toHaveBeenCalled();
});

it("leaves Settings closed when the destination was opened elsewhere", async () => {
  page.fromSettings = undefined;
  await act(async () => root.render(<Navigator />));
  await act(async () => root.render(<Navigator action="GO_BACK" />));
  expect(page.push).not.toHaveBeenCalled();
});

it("pushes above Settings on Android", () => {
  page.platform.OS = "android";
  openFromSettings({ push: page.push }, { pathname: "/board" }, "/account");
  expect(page.push).toHaveBeenCalledExactlyOnceWith({ pathname: "/board" });
});

it("opens Spaces once Account is mounted and clears the return marker", async () => {
  function Account() {
    useRestoreSpaces();
    return null;
  }
  page.fromSettings = "/spaces";
  await act(async () => root.render(<Account />));
  expect(page.setParams).toHaveBeenCalledExactlyOnceWith({ fromSettings: undefined });
  expect(page.push).toHaveBeenCalledExactlyOnceWith("/spaces");
});
