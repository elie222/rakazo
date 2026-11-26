// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import { deferred, flush } from "@rakazo/core/test-async";
import type { ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ArtifactDetail from "../../app/artifact";
import { clearQueries } from "../query/query";

i18n.loadAndActivate({ locale: "en", messages: {} });

const state = vi.hoisted(() => ({
  id: "a",
  focused: true,
  gallery: undefined as string | undefined,
  changeActive: undefined as ((id: string) => void) | undefined,
  refresh: undefined as (() => Promise<unknown>) | undefined,
  actions: [] as { text: string; onPress: () => void }[],
  setOptions: vi.fn(),
  back: vi.fn(),
  alert: vi.fn(),
  remove: vi.fn(),
  download: vi.fn(),
  getArtifact: vi.fn(),
  listVersions: vi.fn(),
  mimeType: "text/plain",
  fileUri: "file:///test",
  fileExists: true,
  options: {} as { headerRight?: () => ReactNode; title?: string },
}));
vi.mock("expo", () => ({ requireOptionalNativeModule: () => null }));
vi.mock("expo-secure-store", () => ({
  getItem: () => null,
  getItemAsync: async () => null,
  setItemAsync: async () => {},
}));
vi.mock("../inbox/activity", () => ({ formatActivityRelativeTime: () => "now" }));
vi.mock("../notifications/live-notifications", () => ({}));
vi.mock("expo-router", () => ({
  useLocalSearchParams: () => ({ artifactId: state.id, gallery: state.gallery }),
  useIsFocused: () => state.focused,
  useRouter: () => ({ back: state.back }),
  useNavigation: () => ({ setOptions: state.setOptions }),
  useFocusEffect: (effect: () => () => void) => {
    useEffect(() => (state.focused ? effect() : undefined), [effect, state.focused]);
  },
}));
vi.mock("../api/roster-signals", () => ({
  useSpaceChanges: (_kind: string, refresh: () => Promise<unknown>) => {
    state.refresh = refresh;
  },
}));
vi.mock("../api/api", () => ({
  currentApiBase: () => "https://fixture.example",
  selectedSpaceId: () => "test-space",
  captureApiRequestContext: async () => ({
    apiBase: "https://fixture.example",
    sessionGeneration: 0,
    headers: { "x-rakazo-space-id": "test-space" },
  }),
  rpc: (proc: string, input: { familyId?: string; artifactId?: string }) => {
    if (proc === "artifacts/listVersions") return state.listVersions(input.familyId);
    if (proc === "artifacts/remove") return state.remove(input.artifactId);
    if (proc === "artifacts/getById") return state.getArtifact(input.artifactId);
    throw new Error(`Unexpected RPC: ${proc}`);
  },
}));
vi.mock("../api/session", () => ({ currentSessionGeneration: () => 0 }));
vi.mock("../platform/app-foreground", () => ({ useAppForeground: () => true }));
vi.mock("../../components/native/native-action-button", () => ({
  NativeActionButton: ({ label, onPress }: { label: string; onPress: () => void }) =>
    createElement("button", { type: "button", "aria-label": label, onClick: onPress }, label),
}));
vi.mock("react-native", () => {
  const component = ({
    children,
    accessibilityLabel,
    onPress,
  }: {
    children?: ReactNode;
    accessibilityLabel?: string;
    onPress?: () => void;
  }) => createElement("div", { "aria-label": accessibilityLabel, onClick: onPress }, children);
  return {
    View: component,
    Text: component,
    ScrollView: component,
    Pressable: component,
    Image: component,
    FlatList: component,
    ActivityIndicator: () => null,
    Platform: { OS: "android" },
    StyleSheet: { create: (value: unknown) => value },
    Alert: { alert: state.alert },
  };
});
vi.mock("@rakazo/chat-ui/native", () => ({ ChatMarkdown: () => null }));
vi.mock("../../components/native/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("../../components/media/pdf-preview", () => ({ PdfPreview: () => null }));
vi.mock("../../components/media/sandboxed-html-preview", () => ({
  SandboxedHtmlPreview: () => null,
}));
vi.mock("../../components/media/video-preview", () => ({ VideoPreview: () => null }));
vi.mock("../../components/media/artifact-media-pager", () => ({
  ArtifactMediaPager: ({
    onActiveIdChange,
    children,
  }: {
    onActiveIdChange: (id: string) => void;
    children: ReactNode;
  }) => {
    state.changeActive = onActiveIdChange;
    return children;
  },
}));
vi.mock("./artifact-open", () => ({
  writeArtifactCacheFile: () => ({
    text: async () => "text",
    uri: state.fileUri,
    exists: state.fileExists,
  }),
  shareLocalFile: vi.fn(),
}));
vi.mock("./artifact-download", () => ({ downloadArtifactToDevice: state.download }));
vi.mock("../layout/floating-header", () => ({ useFloatingHeaderInset: () => 0 }));
vi.mock("../layout/side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("../native/native-controls", () => ({ iosAtLeast: () => false }));
vi.mock("../native/native", () => ({
  native: {},
  useResolvedAppearance: () => "light",
  useThemedStyles: () => ({}),
}));
vi.mock("../appearance/appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("../messages/message-action-sheet", () => ({
  presentMessageActionSheet: ({ actions }: { actions: typeof state.actions }) => {
    state.actions = actions;
  },
}));

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let mounted: boolean;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.id = "a";
  state.focused = true;
  state.gallery = undefined;
  state.changeActive = undefined;
  state.refresh = undefined;
  state.actions = [];
  state.options = {};
  state.setOptions.mockImplementation((options: typeof state.options) => {
    state.options = options;
  });
  state.back.mockReset();
  state.alert.mockReset();
  state.remove.mockReset();
  state.download.mockReset();
  state.getArtifact.mockReset();
  state.listVersions.mockReset().mockImplementation(async (id: string) => [{ id }]);
  state.getArtifact.mockImplementation(async (id: string) => ({
    id,
    name: id,
    mimeType: state.mimeType,
    contentBase64: "",
  }));
  state.mimeType = "text/plain";
  state.fileUri = "file:///test";
  state.fileExists = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mounted = true;
});
afterEach(() => {
  if (mounted) act(() => root.unmount());
  clearQueries();
  container.remove();
  vi.unstubAllGlobals();
});
async function waitForTitle(title: string) {
  await vi.waitFor(async () => {
    await act(async () => flush());
    expect(state.options.title).toBe(title);
    expect(state.options.headerRight).toBeTypeOf("function");
  });
}
async function render(waitForReady = true) {
  await act(async () => root.render(<ArtifactDetail />));
  if (waitForReady) await waitForTitle(state.id);
}
async function openActions() {
  const node = document.createElement("div");
  const buttons = createRoot(node);
  act(() => buttons.render(state.options.headerRight?.()));
  act(() => node.querySelector<HTMLElement>('[aria-label="More"]')!.click());
  act(() => buttons.unmount());
  return state.actions;
}
async function pressHeader(label: string) {
  const actions = await openActions();
  await act(async () => actions.find((action) => action.text === label)!.onPress());
}
async function startDelete() {
  const pending = deferred();
  state.remove.mockReturnValue(pending.promise);
  await render();
  await pressHeader("Delete");
  await act(async () =>
    state.alert.mock
      .lastCall![2].find((button: { style: string }) => button.style === "destructive")
      .onPress(),
  );
  expect(state.remove).toHaveBeenCalledWith("a");
  state.alert.mockClear();
  return pending;
}
it("returns after deleting the focused artifact", async () => {
  const pending = await startDelete();
  await act(async () => pending.resolve());
  expect(state.back).toHaveBeenCalledOnce();
});
it.each(["blur", "target", "unmount", "refocus"])("does not navigate after %s", async (change) => {
  const pending = await startDelete();
  if (change === "unmount") {
    act(() => root.unmount());
    mounted = false;
  } else if (change === "target") {
    state.id = "b";
    await render();
  } else {
    state.focused = false;
    await render();
    if (change === "refocus") {
      state.focused = true;
      await render();
    }
  }
  await act(async () => pending.resolve());
  expect(state.back).not.toHaveBeenCalled();
});
it("reports a current deletion failure without navigating", async () => {
  const pending = await startDelete();
  await act(async () => pending.reject(new Error("offline")));
  expect(state.back).not.toHaveBeenCalled();
  expect(state.alert).toHaveBeenCalledOnce();
});
it("ignores a failure after leaving the artifact", async () => {
  const pending = await startDelete();
  state.focused = false;
  await render();
  await act(async () => pending.reject(new Error("offline")));
  expect(state.alert).not.toHaveBeenCalled();
});
it("offers Download for an image and saves its cached file", async () => {
  state.mimeType = "image/png";
  state.download.mockResolvedValue("saved");
  await render();
  await pressHeader("Download");
  expect(state.download).toHaveBeenCalledWith("file:///test", "image/png", "a");
  expect(state.alert).toHaveBeenCalledWith("Saved to Photos");
});
it("does not offer Download for a text artifact", async () => {
  await render();
  const actions = await openActions();
  expect(actions.map((action) => action.text)).toEqual(["Share", "Delete"]);
});
it("reloads a purged cached file before saving", async () => {
  state.mimeType = "image/png";
  state.fileUri = "file:///gone";
  state.fileExists = false;
  state.download.mockResolvedValue("saved");
  await render();
  state.fileUri = "file:///fresh";
  await pressHeader("Download");
  await vi.waitFor(() => expect(state.download).toHaveBeenCalled());
  expect(state.download).toHaveBeenCalledWith("file:///fresh", "image/png", "a");
});
it("keeps a save from reporting over the next artifact", async () => {
  state.mimeType = "image/png";
  const saving = deferred<"saved">();
  state.download.mockReturnValue(saving.promise);
  await render();
  await pressHeader("Download");
  state.id = "b";
  await render();
  await act(async () => saving.resolve("saved"));
  expect(state.alert).not.toHaveBeenCalled();
});
it("starts the next artifact's save and deduplicates a return to the first", async () => {
  state.mimeType = "image/png";
  state.gallery = JSON.stringify(
    ["a", "b"].map((id) => ({ id, name: id, mimeType: state.mimeType })),
  );
  const saving = deferred<"saved">();
  state.download.mockReturnValueOnce(saving.promise).mockResolvedValue("shared");
  await render();
  await pressHeader("Download");
  await act(async () => state.changeActive?.("b"));
  await waitForTitle("b");
  await pressHeader("Download");
  await act(async () => state.changeActive?.("a"));
  await waitForTitle("a");
  await pressHeader("Download");
  expect(state.download.mock.calls.map(([, , name]) => name)).toEqual(["a", "b"]);
  await act(async () => saving.resolve("saved"));
  expect(state.alert).not.toHaveBeenCalled();
});
it("does not load the artifact the route left", async () => {
  const slow = deferred<{ id: string; name: string; mimeType: string; contentBase64: string }>();
  state.getArtifact.mockImplementation((id: string) =>
    id === "a"
      ? slow.promise
      : Promise.resolve({ id, name: id, mimeType: state.mimeType, contentBase64: "" }),
  );
  await render(false);
  await vi.waitFor(async () => {
    await act(async () => flush());
    expect(state.getArtifact).toHaveBeenCalledWith("a");
  });
  state.id = "b";
  await render();
  expect(state.getArtifact.mock.calls.map(([id]) => id)).toEqual(["a", "b"]);
  await act(async () =>
    slow.resolve({ id: "a", name: "a", mimeType: state.mimeType, contentBase64: "" }),
  );
  expect(state.options.title).toBe("b");
});

it("keeps the preview after a failed focus refresh without re-downloading it", async () => {
  await render();
  state.focused = false;
  await render(false);
  const offline = deferred<never>();
  state.listVersions.mockReturnValueOnce(offline.promise);
  state.focused = true;
  await render(false);
  await vi.waitFor(() => expect(state.listVersions).toHaveBeenCalledTimes(2));
  await act(async () => {
    offline.reject(new Error("Offline"));
    await flush();
  });
  expect(state.options.title).toBe("a");
  expect(await openActions()).toHaveLength(2);
  expect(state.getArtifact).toHaveBeenCalledOnce();
});

it("hides a removed artifact and disables actions from a previously opened menu", async () => {
  state.mimeType = "image/png";
  await render();
  const actions = await openActions();
  state.listVersions.mockRejectedValueOnce(
    Object.assign(new Error("Artifact not found"), {
      status: 404,
      code: "NOT_FOUND",
    }),
  );
  await act(async () => {
    await state.refresh?.();
    await flush();
  });
  await vi.waitFor(async () => {
    await act(async () => flush());
    expect(container.textContent).toContain("Artifact not found");
    expect(state.options.headerRight).toBeUndefined();
  });
  await act(async () => actions.find((action) => action.text === "Download")!.onPress());
  expect(state.getArtifact).toHaveBeenCalledOnce();
  expect(state.download).not.toHaveBeenCalled();
});
