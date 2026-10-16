// @vitest-environment jsdom
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { GlassTitle } from "../components/glass-title.ios";
import { HEADER_CONTROL_SIZE, HEADER_TITLE_MAX_FONT_SCALE } from "./native-controls";

const window = vi.hoisted(() => ({ fontScale: 1 }));
vi.mock("react-native", () => ({
  Platform: { OS: "ios", Version: 26 },
  StyleSheet: { create: (styles: unknown) => styles, absoluteFill: {} },
  Text: ({
    children,
    allowFontScaling,
    style,
  }: {
    children: ReactNode;
    allowFontScaling?: boolean;
    style?: { fontSize?: number } | { fontSize?: number }[];
  }) => (
    <span
      data-font-scaling={String(allowFontScaling)}
      data-font-size={Object.assign({}, ...[style].flat()).fontSize}
    >
      {children}
    </span>
  ),
  View: ({ children, style }: { children: ReactNode; style?: { height?: number } }) => (
    <div data-height={style?.height}>{children}</div>
  ),
  useWindowDimensions: () => window,
}));
vi.mock("@expo/ui/swift-ui", () => ({
  Host: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Text: ({ children, modifiers }: { children: ReactNode; modifiers: unknown[] }) => (
    <span data-modifiers={JSON.stringify(modifiers)}>{children}</span>
  ),
}));
vi.mock("@expo/ui/swift-ui/modifiers", () => {
  const modifier = (name: string) => (params: unknown) => ({ [name]: params });
  return {
    dynamicTypeSize: modifier("dynamicTypeSize"),
    font: modifier("font"),
    frame: modifier("frame"),
    glassEffect: modifier("glassEffect"),
    lineLimit: modifier("lineLimit"),
    padding: modifier("padding"),
  };
});
vi.mock("./native", () => ({ useResolvedAppearance: () => "light" }));

it.each(["", "   "])("omits glass chrome for an empty title %j", (title) => {
  expect(renderToStaticMarkup(<GlassTitle title={title} />)).toBe("");
});

it("preserves a named floating header", () => {
  expect(renderToStaticMarkup(<GlassTitle title="Models" />)).toContain("Models");
});

it("draws the glass at the header buttons' height", () => {
  const markup = renderToStaticMarkup(<GlassTitle title="Models" />);
  expect(markup).toContain(`data-height="${HEADER_CONTROL_SIZE}"`);
  const modifiers: Record<string, unknown>[] = JSON.parse(
    new DOMParser()
      .parseFromString(markup, "text/html")
      .querySelector("[data-modifiers]")
      ?.getAttribute("data-modifiers") ?? "[]",
  );
  const frame = modifiers.findIndex((modifier) => "frame" in modifier);
  expect(modifiers[frame]).toEqual({ frame: { height: HEADER_CONTROL_SIZE } });
  expect(modifiers.findIndex((modifier) => "glassEffect" in modifier)).toBe(frame + 1);
  expect(modifiers).toContainEqual({ dynamicTypeSize: { min: "large", max: "xxxLarge" } });
});

// The bar keeps its title between the default text size and xxxLarge, so the invisible copy that
// sizes the capsule must too; otherwise small text sizes truncate short titles.
it.each([
  [0.823, 17],
  [1, 17],
  [1.235, 17 * 1.235],
  [3.1, 17 * HEADER_TITLE_MAX_FONT_SCALE],
])("sizes the capsule for the text the bar draws at font scale %s", (fontScale, fontSize) => {
  window.fontScale = fontScale;
  const markup = renderToStaticMarkup(<GlassTitle title="Chat settings" />);
  expect(markup).toContain('data-font-scaling="false"');
  expect(markup).toContain(`data-font-size="${fontSize}"`);
});
