// @vitest-environment jsdom
import { deferred, flush } from "@rakazo/core/test-async";
import type { ReactNode } from "react";
import { act, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import MeetingTranscriptScreen from "../../app/meeting-transcript";
import { queryClient } from "../query/query";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  id: "meeting-fixture",
  refetch: undefined as (() => unknown) | undefined,
}));
vi.mock("../api/api", () => ({
  currentApiBase: () => "https://app.example.test",
  selectedSpaceId: () => "space-fixture",
  captureApiRequestContext: async () => ({ apiBase: "https://app.example.test", headers: {} }),
  rpc: (method: string, input: unknown) => mocks.rpc(method, input),
}));
vi.mock("../api/roster-signals", () => ({
  useSpaceChanges: (_topic: string, onChange: () => unknown) => {
    mocks.refetch = onChange;
  },
}));
vi.mock("../api/session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("../appearance/appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("../layout/side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("../native/native", () => ({
  native: {},
  useThemedStyles: (create: () => unknown) => create(),
}));
vi.mock("../navigation/screen-header", () => ({ useScreenHeader: () => undefined }));
vi.mock("../platform/app-foreground", () => ({ useAppForeground: () => true }));
vi.mock("expo-router", () => ({
  useIsFocused: () => true,
  useLocalSearchParams: () => ({ id: mocks.id, botId: "bot-fixture" }),
  useRouter: () => ({ back: vi.fn() }),
  useFocusEffect: (effect: () => undefined | (() => void)) => useEffect(effect, [effect]),
}));
vi.mock("../../components/settings/settings-group", () => ({
  SettingsGroup: () => null,
  SettingsRow: () => null,
}));
vi.mock("../../components/native/native-action-button", () => ({
  NativeActionButton: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button type="button" onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("react-native", () => ({
  ActivityIndicator: ({ accessibilityLabel }: { accessibilityLabel: string }) => (
    <span role="status">{accessibilityLabel}</span>
  ),
  Alert: { alert: vi.fn() },
  FlatList: ({
    data,
    keyExtractor,
    renderItem,
    ListHeaderComponent,
    ListFooterComponent,
  }: {
    data?: unknown[];
    keyExtractor: (item: unknown, index: number) => string;
    renderItem: (row: { item: unknown }) => ReactNode;
    ListHeaderComponent?: ReactNode;
    ListFooterComponent?: ReactNode;
  }) => (
    <div>
      {ListHeaderComponent}
      {data?.map((item, index) => (
        <div key={keyExtractor(item, index)}>{renderItem({ item })}</div>
      ))}
      {ListFooterComponent}
    </div>
  ),
  StyleSheet: { create: (styles: unknown) => styles },
  Text: ({
    children,
    accessibilityRole,
  }: {
    children?: ReactNode;
    accessibilityRole?: "alert";
  }) => <p role={accessibilityRole}>{children}</p>,
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

const fixture = {
  turns: [{ startMs: 1000, speaker: "Example speaker", text: "Example transcript text" }],
  artifactAvailable: true,
};
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  queryClient.clear();
  mocks.rpc.mockReset();
  mocks.refetch = undefined;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () => root.render(<MeetingTranscriptScreen />));
  await act(flush);
}
const alerts = () => container.querySelectorAll('[role="alert"]');
const spinner = () => container.querySelector('[role="status"]');
const retry = () =>
  [...container.querySelectorAll("button")].find((button) => button.textContent === "Retry");

it("retries the same transcript after its first read fails", async () => {
  const first = deferred<typeof fixture>();
  const second = deferred<typeof fixture>();
  mocks.rpc
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise);
  await render();
  expect(spinner()?.textContent).toBe("Loading transcript…");
  expect(retry()).toBeUndefined();

  await act(async () => first.reject(new Error("Failed to fetch")));
  await act(flush);
  expect(alerts()).toHaveLength(1);
  expect(spinner()).toBeNull();
  expect(retry()).toBeDefined();

  await act(async () => retry()?.click());
  await act(flush);
  expect(mocks.rpc.mock.calls).toEqual([
    ["meetings/transcript", { id: mocks.id }],
    ["meetings/transcript", { id: mocks.id }],
  ]);
  expect(spinner()?.textContent).toBe("Loading transcript…");
  expect(alerts()).toHaveLength(0);

  await act(async () => second.resolve(fixture));
  await act(flush);
  expect(container.textContent).toContain(fixture.turns[0]?.text);
  expect(alerts()).toHaveLength(0);
  expect(spinner()).toBeNull();
  expect(retry()).toBeUndefined();
});

it("keeps the existing display and error policy for a cached transcript refresh", async () => {
  mocks.rpc.mockResolvedValueOnce(fixture);
  await render();
  expect(container.textContent).toContain(fixture.turns[0]?.text);

  const refresh = deferred<typeof fixture>();
  mocks.rpc.mockImplementationOnce(() => refresh.promise);
  await act(async () => {
    void mocks.refetch?.();
  });
  await act(flush);
  expect(container.textContent).toContain(fixture.turns[0]?.text);
  expect(spinner()).toBeNull();

  await act(async () => refresh.reject(new Error("Failed to fetch")));
  await act(flush);
  expect(alerts()).toHaveLength(1);
  expect(retry()).toBeUndefined();
});
