// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import type { Bot } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CommandPalette } from "./command-palette";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));

const bots = [
  { id: "bot-1", name: "First", description: "", preview: "", avatarSet: "default" },
  { id: "bot-2", name: "Second", description: "", preview: "", avatarSet: "default" },
] as unknown as Bot[];

let root: ReturnType<typeof createRoot>;

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
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  Element.prototype.scrollIntoView = () => {};
  root = createRoot(document.body.appendChild(document.createElement("div")));
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  delete window.rakazoDesktop;
});

async function open({
  bots: shown = bots,
  onSelectBot = () => {},
}: {
  bots?: Bot[];
  onSelectBot?: (id: string) => void;
} = {}) {
  await act(async () =>
    root.render(
      <I18nProvider i18n={i18n}>
        <CommandPalette
          open
          onOpenChange={() => {}}
          bots={shown}
          onSelectBot={onSelectBot}
          actions={[]}
        />
      </I18nProvider>,
    ),
  );
}

const shortcutHints = () => [...document.querySelectorAll("kbd")].map((kbd) => kbd.textContent);

const pressMod1 = () => {
  const event = new KeyboardEvent("keydown", { key: "1", ctrlKey: true, cancelable: true });
  act(() => {
    window.dispatchEvent(event);
  });
  return event;
};

it("names the search input so a screen reader announces it", async () => {
  await open({ bots: [] });
  const input = document.querySelector<HTMLInputElement>('[role="combobox"]');
  // aria-label wins the name computation; without it the name comes from cmdk's label element.
  const name =
    input?.getAttribute("aria-label") ||
    [...(input?.labels ?? [])].map((label) => label.textContent).join(" ");
  expect(name?.trim()).toBe("Search");
});

it("shows no number shortcut hints in a browser", async () => {
  await open();
  expect(document.querySelector('[data-testid="command-palette-bot-bot-1"]')).not.toBeNull();
  expect(shortcutHints()).toEqual([]);
});

it("shows number shortcut hints in the desktop app", async () => {
  window.rakazoDesktop = {} as never;
  await open();
  expect(shortcutHints()).toHaveLength(2);
  expect(shortcutHints()[0]).toMatch(/1$/);
  expect(shortcutHints()[1]).toMatch(/2$/);
});

it("leaves Cmd/Ctrl+number to the browser", async () => {
  const onSelectBot = vi.fn();
  await open({ onSelectBot });
  expect(pressMod1().defaultPrevented).toBe(false);
  expect(onSelectBot).not.toHaveBeenCalled();
});

it("selects the bot on Cmd/Ctrl+number in the desktop app", async () => {
  window.rakazoDesktop = {} as never;
  const onSelectBot = vi.fn();
  await open({ onSelectBot });
  expect(pressMod1().defaultPrevented).toBe(true);
  expect(onSelectBot).toHaveBeenCalledWith("bot-1");
});
