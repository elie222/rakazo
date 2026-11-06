// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { InlineHtmlPage } from "./InlineHtmlPage";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => `${text}${part}${values[index] ?? ""}`, ""),
  }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it("draws the page in the chat and opens the full view from its footer", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(private callback: (entries: { isIntersecting: boolean }[]) => void) {}
      observe() {
        this.callback([{ isIntersecting: true }]);
      }
      disconnect() {}
    },
  );
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  const open = vi.fn();
  await act(async () =>
    root.render(<InlineHtmlPage title="Inline report" document="<p>page</p>" onOpen={open} />),
  );
  const card = document.querySelector('[data-testid="inline-page"]')!;
  expect(card.querySelector("iframe")).not.toBeNull();
  await act(async () => {
    card.querySelector<HTMLButtonElement>('button[aria-label="Open Inline report"]')!.click();
  });
  expect(open).toHaveBeenCalledTimes(1);
  act(() => root.unmount());
});

it("says a page could not be read instead of leaving its placeholder pulsing", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("IntersectionObserver", undefined);
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root.render(<InlineHtmlPage title="Plan" document={null} />));
  expect(document.body.querySelector('[aria-busy="true"]')).not.toBeNull();
  await act(async () =>
    root.render(<InlineHtmlPage title="Plan" document={null} failed onOpen={undefined} />),
  );
  expect(document.body.textContent).toContain("This page couldn't load");
  act(() => root.unmount());
});
