// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  const flatten = (style: unknown): Record<string, unknown> =>
    Array.isArray(style)
      ? Object.assign({}, ...style.map(flatten))
      : ((style as Record<string, unknown>) ?? {});
  return {
    StyleSheet: { hairlineWidth: 1 },
    View: ({ children }: { children?: ReactNode }) => createElement("div", {}, children),
    Text: ({ children, style }: { children?: ReactNode; style?: unknown }) =>
      createElement(
        "span",
        { "data-color": flatten(style).color, "data-weight": flatten(style).fontWeight },
        children,
      ),
  };
});

vi.mock("./native", () => ({
  useMobileTokens: () => ({ foreground: "ink", mutedForeground: "muted", border: "line" }),
}));

import { AskReceiptView } from "../components/ask-receipt";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

it("draws a payment's order as rows, then what is paid, then where it came from", async () => {
  await act(async () =>
    root.render(
      <AskReceiptView
        receipt={{
          button: "Place order",
          items: [{ name: "Bananas × 6", amount: "$3.00" }],
          more: { count: 5, atLeast: false },
          amount: "$17.40",
          amountSource: "page",
        }}
      />,
    ),
  );
  const texts = [...container.querySelectorAll("span")].map((span) => span.textContent);
  expect(texts).toEqual([
    "Bananas × 6",
    "$3.00",
    "5 more",
    "Total",
    "$17.40",
    "Button “Place order” · read from the page, not checked",
  ]);
  const total = [...container.querySelectorAll("span")].find(
    (span) => span.textContent === "$17.40",
  );
  expect(total?.dataset.weight).toBe("500");
});
