// @vitest-environment jsdom

import { deferred } from "@rakazo/core/test-async";
import type { ReactElement, ReactNode } from "react";
import { act, Fragment } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ArtifactsScreen from "../../app/artifacts";

const { listSpaceArtifacts, useSpaceChanges } = vi.hoisted(() => ({
  listSpaceArtifacts: vi.fn(),
  useSpaceChanges: vi.fn<(kind: string, onChange: () => Promise<void>, enabled: boolean) => void>(),
}));

vi.mock("react-native", () => {
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    ActivityIndicator: () => null,
    Alert: { alert: vi.fn() },
    FlatList: ({
      data,
      renderItem,
      ListHeaderComponent,
      ListEmptyComponent,
      refreshControl,
    }: {
      data: { id: string }[];
      renderItem: (props: { item: { id: string } }) => ReactElement;
      ListHeaderComponent: ReactNode;
      ListEmptyComponent: ReactNode;
      refreshControl: ReactNode;
    }) => (
      <div>
        {refreshControl}
        {ListHeaderComponent}
        {data.length
          ? data.map((item) => <Fragment key={item.id}>{renderItem({ item })}</Fragment>)
          : ListEmptyComponent}
      </div>
    ),
    Pressable: Container,
    RefreshControl: ({ onRefresh, refreshing }: { onRefresh: () => void; refreshing: boolean }) => (
      <button type="button" aria-busy={refreshing} onClick={onRefresh}>
        Refresh
      </button>
    ),
    ScrollView: Container,
    StyleSheet: { create: (styles: unknown) => styles },
    Text: ({
      accessibilityRole,
      children,
    }: {
      accessibilityRole?: "alert";
      children: ReactNode;
    }) => <span role={accessibilityRole}>{children}</span>,
    View: Container,
  };
});
vi.mock("expo-router", () => {
  const navigation = { setOptions: vi.fn() };
  return {
    useFocusEffect: () => undefined,
    useIsFocused: () => true,
    useLocalSearchParams: () => ({}),
    useNavigation: () => navigation,
    useRouter: () => ({ push: vi.fn() }),
  };
});
vi.mock("@lingui/core/macro", () => ({ ph: vi.fn() }));
vi.mock("@lingui/react/macro", () => ({ useLingui: () => ({ t: String.raw }) }));
vi.mock("@rakazo/core", () => ({ artifactTypeLabel: () => "PDF" }));
vi.mock("../../components/bots/bot-avatar", () => ({ BotAvatar: () => null }));
vi.mock("../../components/native/native-segmented-control", () => ({
  NativeSegmentedControl: ({ onChange }: { onChange: (value: string) => void }) => (
    <button type="button" onClick={() => onChange("bots")}>
      Filter to bots
    </button>
  ),
}));
vi.mock("../../components/native/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("../api/api", () => ({ rpc: async () => [] }));
vi.mock("../api/roster-signals", () => ({ useSpaceChanges }));
vi.mock("../api/user-error", () => ({ errorText: (error: Error) => error.message }));
vi.mock("../appearance/appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("./artifacts", () => ({
  listSpaceArtifacts,
  matchesArtifactQuery: () => true,
  removeArtifact: vi.fn(),
}));
vi.mock("../inbox/activity", () => ({ formatActivityRelativeTime: () => "just now" }));
vi.mock("../layout/content-bottom-inset", () => ({ useContentBottomInset: () => 0 }));
vi.mock("../layout/side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("../native/native", () => ({ native: {}, useThemedStyles: () => ({}) }));
vi.mock("../query/query", () => ({ rpcQuery: vi.fn() }));
vi.mock("../query/screen-query", () => ({ useScreenQuery: () => ({ data: [] }) }));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  listSpaceArtifacts.mockReset();
  useSpaceChanges.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function page(name: string) {
  return {
    items: [{ id: name, name, mimeType: "application/pdf", version: 1, versionCount: 1 }],
    nextCursor: null,
  };
}

const refreshButton = () => container.querySelector("button");
const refresh = () => act(async () => refreshButton()?.click());
const liveRead = () => useSpaceChanges.mock.lastCall![1];

it("shows one refresh error with the existing rows and clears it after retry", async () => {
  listSpaceArtifacts
    .mockResolvedValueOnce(page("Cached document"))
    .mockRejectedValueOnce(new Error("Could not load artifacts."))
    .mockRejectedValueOnce(new Error("Background request failed."))
    .mockResolvedValueOnce(page("Updated document"));
  await act(async () => root.render(<ArtifactsScreen />));
  expect(container.textContent).toContain("Cached document");
  expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);

  await refresh();
  expect(container.textContent).toContain("Cached document");
  expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Could not load artifacts.");

  const [, onSpaceChange] = useSpaceChanges.mock.lastCall!;
  await act(async () => onSpaceChange());
  expect(container.textContent).toContain("Cached document");
  expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Could not load artifacts.");

  await refresh();
  expect(container.textContent).not.toContain("Cached document");
  expect(container.textContent).toContain("Updated document");
  expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
  expect(listSpaceArtifacts).toHaveBeenCalledTimes(4);
});

it("still shows a first-load error once in the existing empty state", async () => {
  listSpaceArtifacts.mockRejectedValueOnce(new Error("Could not load artifacts."));
  await act(async () => root.render(<ArtifactsScreen />));
  expect(container.textContent?.match(/Could not load artifacts\./g)).toHaveLength(1);
  expect(container.textContent).not.toContain("No artifacts yet");
  expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
});

it("shows a pull failure when its superseding live read also fails", async () => {
  const pull = deferred<ReturnType<typeof page>>();
  const live = deferred<ReturnType<typeof page>>();
  listSpaceArtifacts
    .mockResolvedValueOnce(page("Cached document"))
    .mockReturnValueOnce(pull.promise)
    .mockReturnValueOnce(live.promise)
    .mockResolvedValueOnce(page("Updated document"));
  await act(async () => root.render(<ArtifactsScreen />));
  await refresh();
  await act(async () => void liveRead()());
  expect(listSpaceArtifacts).toHaveBeenCalledTimes(3);
  await act(async () => pull.reject(new Error("Earlier pull failed.")));
  const busyDuringLive = refreshButton()?.getAttribute("aria-busy");
  expect(container.querySelector('[role="alert"]')).toBeNull();

  await act(async () => live.reject(new Error("Could not load artifacts.")));
  expect(refreshButton()?.getAttribute("aria-busy")).toBe("false");
  expect(container.textContent).toContain("Cached document");
  const alerts = container.querySelectorAll('[role="alert"]');
  expect(alerts).toHaveLength(1);
  expect(alerts[0]?.textContent).toBe("Could not load artifacts.");
  expect(busyDuringLive).toBe("true");

  await refresh();
  expect(container.textContent).toContain("Updated document");
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it("deduplicates repeat pulls while a manual refresh is pending", async () => {
  const pull = deferred<ReturnType<typeof page>>();
  listSpaceArtifacts
    .mockResolvedValueOnce(page("Cached document"))
    .mockReturnValueOnce(pull.promise);
  await act(async () => root.render(<ArtifactsScreen />));
  await refresh();
  await refresh();
  expect(listSpaceArtifacts).toHaveBeenCalledTimes(2);
  await act(async () => pull.resolve(page("Updated document")));
  expect(container.textContent).toContain("Updated document");
});

it("does not show a stale pull failure after a newer read succeeds", async () => {
  const pull = deferred<ReturnType<typeof page>>();
  listSpaceArtifacts
    .mockResolvedValueOnce(page("Cached document"))
    .mockReturnValueOnce(pull.promise)
    .mockResolvedValueOnce(page("Updated document"));
  await act(async () => root.render(<ArtifactsScreen />));
  await refresh();
  await act(async () => liveRead()());

  expect(refreshButton()?.getAttribute("aria-busy")).toBe("false");
  await act(async () => pull.reject(new Error("Earlier pull failed.")));
  expect(container.textContent).toContain("Updated document");
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it("keeps live-only failures silent when files are cached", async () => {
  listSpaceArtifacts
    .mockResolvedValueOnce(page("Cached document"))
    .mockRejectedValueOnce(new Error("Background request failed."));
  await act(async () => root.render(<ArtifactsScreen />));
  await act(async () => liveRead()());

  expect(container.textContent).toContain("Cached document");
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it("does not carry a pending pull into a new filter", async () => {
  const pull = deferred<ReturnType<typeof page>>();
  const replacement = deferred<ReturnType<typeof page>>();
  listSpaceArtifacts
    .mockResolvedValueOnce(page("All files document"))
    .mockReturnValueOnce(pull.promise)
    .mockReturnValueOnce(replacement.promise)
    .mockRejectedValueOnce(new Error("New filter background failure."));
  await act(async () => root.render(<ArtifactsScreen />));
  await refresh();
  await act(async () => container.querySelectorAll("button")[1]?.click());
  expect(listSpaceArtifacts).toHaveBeenLastCalledWith({
    botId: undefined,
    madeByBots: true,
    limit: 30,
  });
  expect(refreshButton()?.getAttribute("aria-busy")).toBe("false");

  await act(async () => replacement.resolve(page("Bot document")));
  await act(async () => pull.reject(new Error("Old filter pull failed.")));
  await act(async () => liveRead()());
  expect(container.textContent).toContain("Bot document");
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it("does not issue another read from a pending callback after unmount", async () => {
  const pull = deferred<ReturnType<typeof page>>();
  listSpaceArtifacts
    .mockResolvedValueOnce(page("Cached document"))
    .mockReturnValueOnce(pull.promise);
  await act(async () => root.render(<ArtifactsScreen />));
  await refresh();
  const afterLeave = liveRead();
  await act(async () => root.unmount());
  await act(async () => {
    pull.reject(new Error("Late pull failure."));
    await afterLeave();
  });
  expect(listSpaceArtifacts).toHaveBeenCalledTimes(2);
});
