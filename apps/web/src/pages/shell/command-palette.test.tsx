// @vitest-environment jsdom

import type { Bot } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CommandPalette } from "./command-palette";

vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray) => parts.join(""),
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

const bots = [
  { id: "bot-1", name: "First", description: "", preview: "", avatarSet: "default" },
  { id: "bot-2", name: "Second", description: "", preview: "", avatarSet: "default" },
] as unknown as Bot[];

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView ??= () => {};
  window.matchMedia ??= (() => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  })) as never;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (window as { rakazoDesktop?: unknown }).rakazoDesktop;
});

async function open() {
  await act(async () =>
    root.render(
      <CommandPalette
        open
        onOpenChange={() => undefined}
        bots={bots}
        onSelectBot={() => undefined}
        actions={[]}
      />,
    ),
  );
}

const shortcutHints = () => [...document.querySelectorAll("kbd")].map((kbd) => kbd.textContent);

it("shows no number shortcut hints in a browser", async () => {
  await open();
  expect(document.querySelector('[data-testid="command-palette-bot-bot-1"]')).not.toBeNull();
  expect(shortcutHints()).toEqual([]);
});

it("shows number shortcut hints in the desktop app", async () => {
  (window as { rakazoDesktop?: unknown }).rakazoDesktop = {};
  await open();
  expect(shortcutHints()).toHaveLength(2);
  expect(shortcutHints()[0]).toMatch(/1$/);
  expect(shortcutHints()[1]).toMatch(/2$/);
});
