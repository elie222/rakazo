// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import type { ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ArtifactDetail from "../app/artifact";

i18n.loadAndActivate({ locale: "en", messages: {} });

const state = vi.hoisted(() => ({
  id: "a",
  focused: true,
  back: vi.fn(),
  alert: vi.fn(),
  remove: vi.fn(),
  options: {} as { headerRight?: () => ReactNode },
}));
vi.mock("expo-secure-store", () => ({
  getItem: () => null,
  getItemAsync: async () => null,
  setItemAsync: async () => {},
}));
vi.mock("./activity", () => ({ formatActivityRelativeTime: () => "now" }));
vi.mock("./live-notifications", () => ({}));
vi.mock("./api-server", () => ({}));
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
    ActivityIndicator: () => null,
    Platform: { OS: "android" },
    StyleSheet: { create: (value: unknown) => value },
    Alert: { alert: state.alert },
  };
});
vi.mock("@rakazo/chat-ui/native", () => ({ ChatMarkdown: () => null }));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("../components/pdf-preview", () => ({ PdfPreview: () => null }));
vi.mock("../components/sandboxed-html-preview", () => ({ SandboxedHtmlPreview: () => null }));
vi.mock("../components/video-preview", () => ({ VideoPreview: () => null }));
vi.mock("./artifacts", () => ({
  listArtifactVersions: async (id: string) => [{ id }],
  getArtifactById: async (id: string) => ({
    id,
    name: id,
    mimeType: "text/plain",
    contentBase64: "",
  }),
  artifactThreadTarget: () => null,
  removeArtifact: state.remove,
}));
vi.mock("./artifact-open", () => ({
  writeArtifactCacheFile: () => ({ text: async () => "text", uri: "file:///test" }),
  shareLocalFile: vi.fn(),
}));
vi.mock("./floating-header", () => ({ useFloatingHeaderInset: () => 0 }));
vi.mock("./side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("./native-controls", () => ({ iosAtLeast: () => false }));
vi.mock("./native", () => ({
  native: {},
  useResolvedAppearance: () => "light",
  useThemedStyles: () => ({}),
}));
vi.mock("./appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("./message-action-sheet", () => ({ presentMessageActionSheet: vi.fn() }));

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
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
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
