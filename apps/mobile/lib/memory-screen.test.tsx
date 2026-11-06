// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import MemoryScreen from "../app/(settings)/memory";
import { queryClient } from "./query";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  rpc: vi.fn(),
  t: (text: string) => text,
}));
vi.mock("./side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("./appearance", () => ({ mobileTokens: () => ({ destructive: "#f00" }) }));
vi.mock("./native", () => ({
  native: {},
  useThemedStyles: (create: () => unknown) => create(),
}));
vi.mock("./i18n", () => ({ t: mocks.t, useI18n: () => ({ t: mocks.t }) }));
vi.mock("./api-server", () => ({}));
vi.mock("./api-auth", () => ({}));
vi.mock("./api-live", () => ({}));
vi.mock("./api", () => ({
  currentApiBase: () => "https://app.example.test",
  selectedSpaceId: () => "space-fixture",
  captureApiRequestContext: async () => ({ apiBase: "https://app.example.test", headers: {} }),
  rpc: (method: string, input: unknown) => mocks.rpc(method, input),
}));
vi.mock("./session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("expo-router", () => ({
  useRouter: () => ({ push: mocks.push }),
  useFocusEffect: (effect: () => (() => void) | undefined) => useEffect(effect, [effect]),
}));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../components/settings-group", () => ({
  SettingsGroup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SettingsRow: ({ title, onPress }: { title: string; onPress?: () => void }) => (
    <button type="button" aria-label={title} onClick={onPress}>
      {title}
    </button>
  ),
}));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button type="button" onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("react-native", () => {
  const View = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    View,
    ScrollView: ({
      children,
      refreshControl,
    }: {
      children?: ReactNode;
      refreshControl?: ReactNode;
    }) => (
      <div>
        {refreshControl}
        {children}
      </div>
    ),
    RefreshControl: ({ onRefresh }: { onRefresh: () => void }) => (
      <button type="button" aria-label="Refresh" onClick={onRefresh} />
    ),
    Text: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
    ActivityIndicator: () => <span role="status" />,
    StyleSheet: { create: (styles: unknown) => styles },
  };
});

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  queryClient.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function settle() {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}
async function render() {
  await act(async () => root.render(<MemoryScreen />));
  await settle();
}

it("lists the space's shared notes and opens one in the editor", async () => {
  mocks.rpc.mockResolvedValue([
    { id: "index-1", scope: "user", botId: null, path: "MEMORY.md", content: "", revision: 1 },
    { id: "team-1", scope: "user", botId: null, path: "team.md", content: "x", revision: 2 },
  ]);
  await render();
  expect(mocks.rpc).toHaveBeenCalledWith("memory/list", { scope: "user" });
  expect(container.textContent).toContain("MEMORY.md");
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="team.md"]')?.click(),
  );
  expect(mocks.push).toHaveBeenCalledWith({ pathname: "/memory-note", params: { id: "team-1" } });
});

it("says when nothing is remembered, and retries a failed load", async () => {
  mocks.rpc.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce([]);
  await render();
  expect(container.textContent).toContain("offline");
  const retry = [...container.querySelectorAll("button")].find((b) => b.textContent === "Retry");
  await act(async () => retry?.click());
  await settle();
  expect(container.textContent).toContain("Nothing remembered yet");
  expect(container.textContent).not.toContain("offline");
});

it("keeps the newest list when an earlier load finishes last", async () => {
  let finishFirst!: (docs: unknown[]) => void;
  mocks.rpc
    .mockResolvedValueOnce([{ id: "old", path: "deleted.md" }])
    .mockReturnValueOnce(new Promise((resolve) => (finishFirst = resolve)))
    .mockResolvedValueOnce([]);
  await render();
  const refresh = () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Refresh"]')?.click();
  await act(async () => refresh());
  await act(async () => refresh());
  await settle();
  expect(container.textContent).toContain("Nothing remembered yet");
  await act(async () => finishFirst([{ id: "old", path: "deleted.md" }]));
  await settle();
  expect(container.textContent).not.toContain("deleted.md");
});
