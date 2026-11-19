// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import { deferred } from "@rakazo/core/test-async";
import type { ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ArtifactDetail from "../../app/artifact";

i18n.loadAndActivate({ locale: "en", messages: {} });

const state = vi.hoisted(() => ({
  id: "a",
  focused: true,
  back: vi.fn(),
  alert: vi.fn(),
  remove: vi.fn(),
  download: vi.fn(),
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
  useLocalSearchParams: () => ({ artifactId: state.id }),
  useRouter: () => ({ back: state.back }),
  useNavigation: () => ({
    setOptions: (options: typeof state.options) => {
      state.options = options;
    },
  }),
  useFocusEffect: (effect: () => () => void) => {
    useEffect(() => (state.focused ? effect() : undefined), [effect, state.focused]);
  },
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
vi.mock("../../components/media/artifact-media-pager", () => ({ ArtifactMediaPager: () => null }));
vi.mock("./artifacts", () => ({
  listArtifactVersions: async (id: string) => [{ id }],
  getArtifactById: async (id: string) => ({
    id,
    name: id,
    mimeType: state.mimeType,
    contentBase64: "",
  }),
  artifactThreadTarget: () => null,
  removeArtifact: state.remove,
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
vi.mock("../messages/message-action-sheet", () => ({ presentMessageActionSheet: vi.fn() }));

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let mounted: boolean;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.id = "a";
  state.focused = true;
  state.back.mockReset();
  state.alert.mockReset();
  state.remove.mockReset();
  state.download.mockReset();
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
  container.remove();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () => root.render(<ArtifactDetail />));
}
async function pressHeader(label: string) {
  const node = document.createElement("div");
  const buttons = createRoot(node);
  act(() => buttons.render(state.options.headerRight?.()));
  await act(async () => node.querySelector<HTMLElement>(`[aria-label="${label}"]`)!.click());
  act(() => {
    buttons.unmount();
  });
}
async function startDelete() {
  const pending = deferred();
  state.remove.mockReturnValue(pending.promise);
  await render();
  const node = document.createElement("div");
  const buttons = createRoot(node);
  act(() => buttons.render(state.options.headerRight?.()));
  act(() => node.querySelector<HTMLElement>('[aria-label="Delete"]')!.click());
  act(() =>
    state.alert.mock
      .lastCall![2].find((button: { style: string }) => button.style === "destructive")
      .onPress(),
  );
  act(() => {
    buttons.unmount();
  });
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
  const node = document.createElement("div");
  const buttons = createRoot(node);
  act(() => buttons.render(state.options.headerRight?.()));
  await act(async () => node.querySelector<HTMLElement>('[aria-label="Download"]')!.click());
  expect(state.download).toHaveBeenCalledWith("file:///test", "image/png", "a");
  expect(state.alert).toHaveBeenCalledWith("Saved to Photos");
  act(() => {
    buttons.unmount();
  });
});
it("does not offer Download for a text artifact", async () => {
  await render();
  const node = document.createElement("div");
  const buttons = createRoot(node);
  act(() => buttons.render(state.options.headerRight?.()));
  expect(node.querySelector('[aria-label="Download"]')).toBeNull();
  expect(node.querySelector('[aria-label="Share"]')).not.toBeNull();
  act(() => {
    buttons.unmount();
  });
});
it("reloads a purged cached file before saving", async () => {
  state.mimeType = "image/png";
  state.fileUri = "file:///gone";
  state.fileExists = false;
  state.download.mockResolvedValue("saved");
  await render();
  state.fileUri = "file:///fresh";
  await pressHeader("Download");
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
it("starts the next artifact's save while one is pending", async () => {
  state.mimeType = "image/png";
  const saving = deferred<"saved">();
  state.download.mockReturnValueOnce(saving.promise).mockResolvedValue("shared");
  await render();
  await pressHeader("Download");
  state.id = "b";
  await render();
  await pressHeader("Download");
  expect(state.download).toHaveBeenCalledTimes(2);
  await act(async () => saving.resolve("saved"));
  expect(state.alert).not.toHaveBeenCalled();
});
