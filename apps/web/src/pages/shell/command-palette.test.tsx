// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CommandPalette } from "./command-palette";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  i18n.load("en", {});
  i18n.activate("en");
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

it("names the search input so a screen reader announces it", async () => {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  try {
    await act(async () =>
      root.render(
        <I18nProvider i18n={i18n}>
          <CommandPalette
            open
            onOpenChange={() => {}}
            bots={[]}
            onSelectBot={() => {}}
            actions={[]}
          />
        </I18nProvider>,
      ),
    );
    const input = document.querySelector<HTMLInputElement>('[role="combobox"]');
    // aria-label wins the name computation; without it the name comes from cmdk's label element.
    const name =
      input?.getAttribute("aria-label") ||
      [...(input?.labels ?? [])].map((label) => label.textContent).join(" ");
    expect(name?.trim()).toBe("Search");
  } finally {
    await act(async () => root.unmount());
  }
});
