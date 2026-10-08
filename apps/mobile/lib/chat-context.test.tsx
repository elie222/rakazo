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
vi.mock("../components/native-symbol", () => ({
  NativeSymbol: ({ ios, color, size }: { ios: string; color: string; size: number }) =>
    createElement("i", { "data-symbol": ios, "data-color": color, "data-size": size }),
}));
vi.mock("react-native", () => ({
  View: ({ children, style }: { children?: ReactNode; style?: object }) =>
    createElement("div", { "data-style": JSON.stringify(style) }, children),
  Pressable: ({
    children,
    style,
    onPress,
    accessibilityRole,
  }: {
    children?: ReactNode;
    style?: object;
    onPress?: () => void;
    accessibilityRole?: string;
  }) =>
    createElement(
      "button",
      {
        type: "button",
        onClick: onPress,
        role: accessibilityRole,
        "data-style": JSON.stringify(style),
      },
      children,
    ),
  Text: ({
    children,
    onPress,
    accessibilityRole,
    selectable,
    numberOfLines,
    style,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityRole?: string;
    selectable?: boolean;
    numberOfLines?: number;
    style?: object;
  }) =>
    createElement(
      "span",
      {
        onClick: onPress,
        role: accessibilityRole,
        "data-selectable": selectable,
        "data-lines": numberOfLines,
        "data-style": JSON.stringify(style),
      },
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

it.each(["user", "bot"] as const)(
  "constrains the %s reply to its bubble column and aligns its text and symbol",
  (role) => {
    act(() =>
      root.render(
        <ReplyLine
          role={role}
          targetId="parent"
          preview={{ role: "bot", text: "A long excerpt" }}
          author="Helper"
        />,
      ),
    );
    expect(
      JSON.parse(container.querySelector("button")!.getAttribute("data-style")!),
    ).toMatchObject({ alignSelf: "stretch", height: 22 });
    expect(JSON.parse(container.querySelector("div")!.getAttribute("data-style")!)).toMatchObject({
      position: "absolute",
      left: 0,
      right: 0,
      justifyContent: role === "user" ? "flex-end" : "flex-start",
    });
    expect(container.querySelector("span")!.getAttribute("data-lines")).toBe("1");
    expect(JSON.parse(container.querySelector("span")!.getAttribute("data-style")!)).toMatchObject({
      flexShrink: 1,
      textAlign: role === "user" ? "right" : "left",
    });
    expect(container.querySelector("i")!.getAttribute("data-symbol")).toBe(
      "arrowshape.turn.up.left",
    );
    expect(container.querySelector("i")!.getAttribute("data-color")).toBe(
      lightTokens.mutedForeground,
    );
    expect(container.querySelector("i")!.getAttribute("data-size")).toBe("12");
  },
);
