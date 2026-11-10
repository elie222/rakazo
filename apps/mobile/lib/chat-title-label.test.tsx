// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CHAT_TITLE_FADE_MS, ChatTitleLabel } from "../components/chat-title-label";

vi.mock("react-native-reanimated", () => ({
  default: {
    Text: ({
      children,
      entering,
      exiting,
    }: {
      children?: ReactNode;
      entering?: { fade: number };
      exiting?: { fade: number };
    }) =>
      createElement("b", { "data-fade": entering?.fade, "data-fade-out": exiting?.fade }, children),
  },
  FadeIn: { duration: (fade: number) => ({ fade }) },
  FadeOut: { duration: (fade: number) => ({ fade }) },
}));
vi.mock("../lib/native-controls", () => ({ HEADER_TITLE_MAX_FONT_SCALE: 1.35 }));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});
const render = (label: string, placeholder = false) =>
  act(() => root.render(<ChatTitleLabel label={label} placeholder={placeholder} style={{}} />));
const shown = () => container.querySelector("b");

it("shows the name at once when the chat opens", () => {
  render("Helper");
  expect(shown()?.textContent).toBe("Helper");
  expect(shown()?.hasAttribute("data-fade")).toBe(false);
});

it("cross-fades the placeholder into the real name: one fades out as the other fades in", () => {
  render("Bot", true);
  expect(shown()?.hasAttribute("data-fade")).toBe(false);
  expect(shown()?.getAttribute("data-fade-out")).toBe(String(CHAT_TITLE_FADE_MS));
  render("Helper");
  expect(shown()?.textContent).toBe("Helper");
  expect(shown()?.getAttribute("data-fade")).toBe(String(CHAT_TITLE_FADE_MS));
});

it("changes a known name in place, without a fade", () => {
  render("Helper");
  expect(shown()?.hasAttribute("data-fade-out")).toBe(false);
  render("Helper 2");
  expect(shown()?.textContent).toBe("Helper 2");
  expect(shown()?.hasAttribute("data-fade")).toBe(false);
});
