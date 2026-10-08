// @vitest-environment jsdom
import { lightTokens } from "@rakazo/ui-tokens";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ReplyLine } from "../components/reply-line";
import { TimeSeparator } from "../components/time-separator";

vi.mock("../lib/appearance", () => ({ mobileTokens: () => lightTokens }));
vi.mock("react-native", () => ({
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
  expect(container.textContent).toBe("↩ Helper: First");
  act(() => (container.firstElementChild as HTMLElement).click());
  expect(onJump).toHaveBeenCalledWith("parent");
});
it("exposes deleted targets as static text", () => {
  const onJump = vi.fn();
  act(() =>
    root.render(<ReplyLine quote="Old text" preview={null} author="Helper" onJump={onJump} />),
  );
  expect(container.textContent).toBe("Original message unavailable");
  act(() => (container.firstElementChild as HTMLElement).click());
  expect(onJump).not.toHaveBeenCalled();
});
