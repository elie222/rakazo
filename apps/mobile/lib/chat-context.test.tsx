// @vitest-environment jsdom
import { lightTokens } from "@rakazo/ui-tokens";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ComposerReplyPreview } from "../components/composer-reply-preview";
import { ReplyLine } from "../components/reply-line";
import { TimeSeparator } from "../components/time-separator";
import { imageArtifactUri } from "./artifact-open";

vi.mock("./artifact-open", () => ({ imageArtifactUri: vi.fn() }));
vi.mock("../lib/appearance", () => ({ mobileTokens: () => lightTokens }));
vi.mock("../components/native-symbol", () => ({
  NativeSymbol: ({ ios, color, size }: { ios: string; color: string; size: number }) =>
    createElement("i", { "data-symbol": ios, "data-color": color, "data-size": size }),
}));
vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => createElement("div", {}, children),
  Image: ({ source, resizeMode }: { source: { uri: string }; resizeMode: string }) =>
    createElement("img", { src: source.uri, "data-resize": resizeMode }),
  Pressable: ({
    children,
    onPress,
    accessibilityRole,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityRole?: string;
  }) =>
    createElement(
      "button",
      { type: "button", onClick: onPress, role: accessibilityRole },
      children,
    ),
  Text: ({
    children,
    onPress,
    accessibilityRole,
    selectable,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityRole?: string;
    selectable?: boolean;
  }) =>
    createElement(
      "span",
      { onClick: onPress, role: accessibilityRole, "data-selectable": selectable },
      children,
    ),
}));
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
it("reads a nonselectable date heading", () => {
  act(() => root.render(<TimeSeparator createdAt={new Date(2026, 9, 8, 14, 20).toISOString()} />));
  expect(container.textContent).toContain("2:20 PM");
  expect(container.firstElementChild?.getAttribute("role")).toBe("header");
  expect(container.firstElementChild?.getAttribute("data-selectable")).toBe("false");
});
it("navigates to the authoritative reply target and hides subsequent lines", () => {
  const onJump = vi.fn();
  act(() =>
    root.render(
      <ReplyLine
        targetId="parent"
        preview={{ role: "bot", text: "First\nSecond" }}
        author="Helper"
        onJump={onJump}
      />,
    ),
  );
  expect(container.textContent).toBe("Helper: First");
  expect(container.textContent).not.toContain("↩");
  const symbol = container.querySelector("i")!;
  expect(symbol.getAttribute("data-symbol")).toBe("arrowshape.turn.up.left");
  expect(symbol.getAttribute("data-color")).toBe(lightTokens.mutedForeground);
  expect(symbol.getAttribute("data-size")).toBe("12");
  expect(container.firstElementChild?.getAttribute("role")).toBe("button");
  act(() => (container.firstElementChild as HTMLElement).click());
  expect(onJump).toHaveBeenCalledWith("parent");
});
it("exposes deleted targets as static text", () => {
  const onJump = vi.fn();
  act(() =>
    root.render(<ReplyLine quote="Old text" preview={null} author="Helper" onJump={onJump} />),
  );
  expect(container.textContent).toBe("Original message unavailable");
  expect(container.querySelector("i")).toBeNull();
  expect(container.firstElementChild?.getAttribute("role")).toBe("text");
  act(() => (container.firstElementChild as HTMLElement).click());
  expect(onJump).not.toHaveBeenCalled();
});

const photo = { kind: "image" as const, artifactId: "photo", mimeType: "image/png", name: "" };
it.each([
  [photo, "", "Photo", true],
  [photo, "Caption", "Caption", true],
  [
    { ...photo, kind: "file" as const, name: "notes.txt", mimeType: "text/plain" },
    "",
    "notes.txt",
    false,
  ],
])(
  "renders attachment labels and thumbnails in the quote and composer",
  async (attachment, text, label, image) => {
    vi.mocked(imageArtifactUri).mockResolvedValue("file:///photo.png");
    await act(async () =>
      root.render(
        <ReplyLine
          targetId="parent"
          author="You"
          preview={{ role: "user", text, attachment }}
          threadTarget={{ groupId: "group" }}
        />,
      ),
    );
    expect(container.textContent).toBe(`You: ${label}`);
    expect(container.querySelector("img")?.getAttribute("src") ?? null).toBe(
      image ? "file:///photo.png" : null,
    );
    await act(async () =>
      root.render(
        <ComposerReplyPreview
          author="You"
          text={text}
          attachment={attachment}
          threadTarget={{ botId: "bot" }}
        />,
      ),
    );
    expect(container.textContent).toBe(`You${label}`);
    expect(container.querySelector("img")?.getAttribute("data-resize") ?? null).toBe(
      image ? "cover" : null,
    );
    if (image)
      expect(imageArtifactUri).toHaveBeenCalledWith({ botId: "bot" }, "photo", "image/png");
  },
);
it("fails softly when a reply image cannot be fetched", async () => {
  vi.mocked(imageArtifactUri).mockRejectedValue(new Error("unavailable"));
  await act(async () =>
    root.render(
      <ReplyLine
        targetId="parent"
        author="You"
        preview={{ role: "user", text: "", attachment: photo }}
        threadTarget={{ botId: "bot" }}
      />,
    ),
  );
  expect(container.textContent).toBe("You: Photo");
  expect(container.querySelector("img")).toBeNull();
});
