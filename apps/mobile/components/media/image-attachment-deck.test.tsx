// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { PressableProps } from "react-native";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { imageArtifactPreview } from "../../lib/artifacts/artifact-open";
import { ImageAttachmentDeck } from "./image-attachment-deck";

const recordPressable = vi.hoisted(() => vi.fn<(props: PressableProps) => void>());

vi.mock("react-native", () => ({
  ActivityIndicator: () => null,
  Pressable: (props: { children?: ReactNode }) => {
    recordPressable(props as PressableProps);
    return createElement("div", null, props.children);
  },
  View: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
  Text: ({ children }: { children?: ReactNode }) => createElement("span", null, children),
  Image: () => createElement("span", { "data-picture": "" }),
  StyleSheet: { create: <T,>(styles: T) => styles },
  useWindowDimensions: () => ({ width: 390 }),
}));
vi.mock("../../lib/appearance/appearance", () => ({
  mobileTokens: () => ({
    muted: "token-muted",
    mutedForeground: "token-muted-foreground",
    foreground: "token-foreground",
  }),
}));
vi.mock("../../lib/artifacts/artifact-open", () => ({ imageArtifactPreview: vi.fn() }));
vi.mock("../native/native-symbol", () => ({
  NativeSymbol: () => createElement("span", { "data-icon": "" }),
}));

const pictures = ["one.png", "two.png", "three.png"].map((name, index) => ({
  artifactId: `image-${index}`,
  name,
  mimeType: "image/png",
}));

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  recordPressable.mockClear();
  vi.mocked(imageArtifactPreview).mockReset();
  vi.mocked(imageArtifactPreview).mockResolvedValue({
    uri: "file:///picture.png",
    size: { width: 240, height: 320 },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function render(images = pictures) {
  const onOpen = vi.fn();
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <ImageAttachmentDeck threadTarget={{ botId: "bot-1" }} images={images} onOpen={onOpen} />,
    ),
  );
  return { container, onOpen, root };
}

it("stacks a message's pictures behind one another and says how many there are", async () => {
  const { container, onOpen } = await render();
  expect(container.textContent).toContain("3 images");
  expect(container.querySelectorAll("[data-picture]")).toHaveLength(3);

  const deck = recordPressable.mock.calls.at(0)?.[0];
  expect(deck?.accessibilityLabel).toBe("Open photo 3 of 3");
  act(() => deck?.onPress?.({} as never));
  expect(onOpen).toHaveBeenCalledTimes(1);
});

it("shows the file name of a picture that could not load", async () => {
  vi.mocked(imageArtifactPreview).mockRejectedValue(new Error("gone"));
  const { container } = await render([pictures[0]!, pictures[1]!]);
  await act(async () => {});
  expect(container.textContent).toContain("one.png");
  expect(container.textContent).toContain("two.png");
});
