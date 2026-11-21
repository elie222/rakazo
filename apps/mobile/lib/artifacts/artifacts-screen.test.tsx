// @vitest-environment jsdom

import type { ReactElement, ReactNode } from "react";
import { act, Fragment } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ArtifactsScreen from "../../app/artifacts";

const { listSpaceArtifacts } = vi.hoisted(() => ({ listSpaceArtifacts: vi.fn() }));

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
    RefreshControl: ({ onRefresh }: { onRefresh: () => void }) => (
      <button type="button" onClick={onRefresh}>
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
  NativeSegmentedControl: () => null,
}));
vi.mock("../../components/native/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("../api/api", () => ({ rpc: vi.fn() }));
vi.mock("../api/roster-signals", () => ({ useSpaceChanges: vi.fn() }));
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

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  listSpaceArtifacts.mockReset();
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

it("shows one refresh error with the existing rows and clears it after retry", async () => {
  listSpaceArtifacts
    .mockResolvedValueOnce(page("Cached document"))
    .mockRejectedValueOnce(new Error("Could not load artifacts."))
    .mockResolvedValueOnce(page("Updated document"));
  await act(async () => root.render(<ArtifactsScreen />));
  expect(container.textContent).toContain("Cached document");
  expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);

  const refresh = () => act(async () => container.querySelector("button")?.click());
  await refresh();
  expect(container.textContent).toContain("Cached document");
  expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Could not load artifacts.");

  await refresh();
  expect(container.textContent).not.toContain("Cached document");
  expect(container.textContent).toContain("Updated document");
  expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
  expect(listSpaceArtifacts).toHaveBeenCalledTimes(3);
});

it("still shows a first-load error once in the existing empty state", async () => {
  listSpaceArtifacts.mockRejectedValueOnce(new Error("Could not load artifacts."));
  await act(async () => root.render(<ArtifactsScreen />));
  expect(container.textContent?.match(/Could not load artifacts\./g)).toHaveLength(1);
  expect(container.textContent).not.toContain("No artifacts yet");
  expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
});
