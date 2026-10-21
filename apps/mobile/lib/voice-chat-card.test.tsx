// @vitest-environment jsdom

import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", async () => {
  const { createElement } = await import("react");

  const element =
    (tag: string) =>
    ({ children, style }: { children?: ReactNode; style?: unknown }) =>
      createElement(
        tag,
        { "data-style": JSON.stringify(Object.assign({}, ...[style].flat())) },
        children,
      );

  return {
    Pressable: element("button"),
    StyleSheet: { create: <T,>(styles: T) => styles },
    Text: element("span"),
    View: element("div"),
  };
});

vi.mock("./i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));

vi.mock("./native", () => ({
  native: { fill: "fill", fillPressed: "fill-pressed" },
  useMobileTokens: () => ({ foreground: "foreground", mutedForeground: "muted" }),
}));

vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));

import { VoiceChatCard } from "../components/VoiceChatCard";

function styleOf(element: Element | null) {
  return JSON.parse(element?.getAttribute("data-style") ?? "{}") as Record<string, unknown>;
}

describe("VoiceChatCard", () => {
  it("keeps its header 40pt tall and lets it grow with the title at larger text sizes", () => {
    const html = renderToStaticMarkup(
      <VoiceChatCard group={{ kind: "voiceChat", key: "call:1", callId: "1", messages: [] }} />,
    );
    const document = new DOMParser().parseFromString(html, "text/html");
    const header = styleOf(document.querySelector("button"));
    const title = styleOf(document.querySelector("button > span"));

    expect(header.height).toBeUndefined();
    expect(header.minHeight).toBe(40);
    expect(Number(header.paddingVertical) * 2 + Number(title.lineHeight)).toBe(40);
  });
});
