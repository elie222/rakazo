// @vitest-environment jsdom

import { flush } from "@rakazo/core/test-async";
import type { ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SpacesSettings from "../../app/(settings)/spaces";
import { queryClient } from "../query/query";
import { registerSettingsSheet } from "../settings/settings-sheet";

const state = vi.hoisted(() => ({
  events: [] as unknown[],
  spaces: [] as { id: string; name: string }[],
  overrides: [] as string[] | Error,
}));
const { element } = vi.hoisted(() => ({
  element:
    (tag: string) =>
    ({ children }: { children?: ReactNode }) =>
      createElement(tag, null, children),
}));

vi.mock("../layout/side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("../platform/app-foreground", () => ({ useAppForeground: () => true }));
vi.mock("../native/native", () => ({
  native: {},
  useThemedStyles: (factory: () => unknown) => factory(),
}));
vi.mock("../api/user-error", () => ({ errorText: (_: unknown, fallback = "Failed") => fallback }));
vi.mock("../api/api", () => ({
  rpc: vi.fn(async (proc: string) => {
    if (proc === "spaces/list") return { spaces: state.spaces };
    if (proc === "spaceSettings/overrides") {
      if (state.overrides instanceof Error) throw state.overrides;
      return state.overrides;
    }
    throw new Error(`Unexpected RPC: ${proc}`);
  }),
  currentApiBase: () => "https://app.example.test",
  selectedSpaceId: () => "space-1",
  captureApiRequestContext: async () => ({
    apiBase: "https://app.example.test",
    sessionGeneration: 1,
    headers: { "x-rakazo-space-id": "space-1" },
  }),
}));
vi.mock("../api/session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("expo-router", () => ({
  useFocusEffect: (effect: () => undefined | (() => void)) => useEffect(effect, [effect]),
  useRouter: () => ({ push: (href: unknown) => state.events.push(href) }),
}));
vi.mock("react-native", () => ({
  ActivityIndicator: () => null,
  Platform: { OS: "ios" },
  ScrollView: element("div"),
  View: element("div"),
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: element("span"),
}));
vi.mock("react-native-safe-area-context", () => ({ SafeAreaView: element("div") }));
vi.mock("../../components/ui/load-failure", () => ({ LoadFailure: () => null }));
vi.mock("../../components/settings/settings-group", () => ({
  SettingsGroup: ({
    label,
    footer,
    children,
  }: {
    label?: string;
    footer?: string;
    children?: ReactNode;
  }) =>
    createElement(
      "section",
      null,
      label ? createElement("h2", null, label) : null,
      children,
      footer ? createElement("p", null, footer) : null,
    ),
  SettingsRow: ({ title, onPress }: { title: string; onPress?: () => void }) =>
    createElement("button", { type: "button", onClick: onPress }, title),
}));

let root: Root;
let container: HTMLDivElement;
let unregister: () => void;

async function render() {
  await act(async () => root.render(createElement(SpacesSettings)));
  await act(flush);
}
const rows = () => Array.from(container.querySelectorAll("button"), (row) => row.textContent);
async function press(title: string) {
  const row = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === title,
  );
  await act(async () => row!.click());
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  queryClient.clear();
  state.events = [];
  state.overrides = [];
  unregister = registerSettingsSheet(() => state.events.push("close"));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  unregister();
  vi.unstubAllGlobals();
});

it("offers one Space's members under its name and a new Space, leaving settings for both and remembering the return from Members", async () => {
  state.spaces = [{ id: "space-1", name: "Personal" }];
  await render();
  expect(rows()).toEqual(["Members", "New private space"]);
  expect(container.querySelector("h2")?.textContent).toBe("Personal");
  expect(container.querySelector("section")?.textContent).not.toContain("New private space");
  expect(container.querySelector("p")?.textContent).toBe(
    "Spaces keep work apart. Bots, chats, memory and computers never cross between them.",
  );

  await press("Members");
  expect(state.events).toEqual([
    "close",
    { pathname: "/space-members", params: { spaceId: "space-1", fromSettings: "/spaces" } },
  ]);
  state.events = [];
  await press("New private space");
  expect(state.events).toEqual(["close", "/new-space"]);
});

it("keeps a lone Space's customized settings reachable", async () => {
  state.spaces = [{ id: "space-1", name: "Personal" }];
  state.overrides = ["voice"];
  await render();
  await vi.waitFor(() =>
    expect(rows()).toEqual(["Members", "Settings for this Space", "New private space"]),
  );

  await press("Settings for this Space");
  expect(state.events).toEqual([
    { pathname: "/space", params: { spaceId: "space-1", name: "Personal" } },
  ]);
});

it("keeps a lone Space's settings reachable when its overrides cannot be read", async () => {
  state.spaces = [{ id: "space-1", name: "Personal" }];
  state.overrides = new Error("offline");
  await render();
  await vi.waitFor(() =>
    expect(rows()).toEqual(["Members", "Settings for this Space", "New private space"]),
  );
});

it("lists each of several Spaces, opening its settings in place", async () => {
  state.spaces = [
    { id: "space-1", name: "Personal" },
    { id: "space-2", name: "Work" },
  ];
  await render();
  expect(rows()).toEqual(["Personal", "Work", "New private space"]);

  await press("Work");
  expect(state.events).toEqual([
    { pathname: "/space", params: { spaceId: "space-2", name: "Work" } },
  ]);
});
