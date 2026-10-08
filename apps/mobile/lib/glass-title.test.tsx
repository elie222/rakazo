// @vitest-environment jsdom
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { GlassTitle } from "../components/glass-title.ios";

vi.mock("react-native", () => ({
  Platform: { OS: "ios", Version: 26 },
  StyleSheet: { create: (styles: unknown) => styles, absoluteFill: {} },
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@expo/ui/swift-ui", () => ({
  Host: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("@expo/ui/swift-ui/modifiers", () => ({
  font: vi.fn(),
  glassEffect: vi.fn(),
  lineLimit: vi.fn(),
  padding: vi.fn(),
}));
vi.mock("./native", () => ({ useResolvedAppearance: () => "light" }));

it.each(["", "   "])("omits glass chrome for an empty title %j", (title) => {
  expect(renderToStaticMarkup(<GlassTitle title={title} />)).toBe("");
});

it("preserves a named floating header", () => {
  expect(renderToStaticMarkup(<GlassTitle title="Models" />)).toContain("Models");
});
