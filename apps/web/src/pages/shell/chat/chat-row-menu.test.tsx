// @vitest-environment jsdom

import { ContextMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@rakazo/ui-web";
import type { ReactNode } from "react";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChatMenuState, ChatMenuSurface, ChatMenuTarget } from "./chat-context-menu";
import { ChatMenu, ChatRowMenu } from "./chat-context-menu";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children?: ReactNode }) => <>{children}</>,
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw(strings, ...values),
  }),
}));

const target: ChatMenuTarget = { kind: "bot", id: "bot-1" };

function Harness({ onOpen }: { onOpen?: (menu: ChatMenuTarget | null) => void }) {
  const [menu, setMenu] = useState<ChatMenuTarget | null>(null);
  const state: ChatMenuState = {
    menu,
    setMenu: (next) => {
      const value = typeof next === "function" ? next(menu) : next;
      onOpen?.(value);
      setMenu(value);
    },
    content: () => (
      <DropdownMenuContent>
        <DropdownMenuItem onClick={() => undefined}>Pin</DropdownMenuItem>
      </DropdownMenuContent>
    ),
    has: () => true,
  };
  return (
    <ChatRowMenu target={target} state={state} label="Actions for Design">
      <span aria-hidden="true">…</span>
    </ChatRowMenu>
  );
}

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
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it("opens the shared chat menu from the row's More button", async () => {
  const seen: (ChatMenuTarget | null)[] = [];
  await act(async () => root.render(<Harness onOpen={(menu) => seen.push(menu)} />));
  expect(document.querySelector('[role="menu"]')).toBeNull();

  const trigger = container.querySelector('button[aria-label="Actions for Design"]');
  expect(trigger).not.toBeNull();
  await act(async () => trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

  expect(seen.at(-1)).toEqual({ kind: "bot", id: "bot-1", via: "dropdown" });
  expect(document.querySelector('[role="menu"]')?.textContent).toContain("Pin");
});

it("closes the menu and releases the shared state on Escape", async () => {
  const seen: (ChatMenuTarget | null)[] = [];
  await act(async () => root.render(<Harness onOpen={(menu) => seen.push(menu)} />));
  const trigger = container.querySelector('button[aria-label="Actions for Design"]');
  await act(async () => trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  expect(document.querySelector('[role="menu"]')).not.toBeNull();

  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });

  expect(seen.at(-1)).toBeNull();
  expect(document.querySelector('[role="menu"]')).toBeNull();
});

it("leaves the newly opened surface alone when the other one closes", async () => {
  const updates: (ChatMenuTarget | null)[] = [];
  let current: ChatMenuTarget | null = { ...target, via: "context" };
  const setMenu = (
    next: ChatMenuTarget | null | ((prev: ChatMenuTarget | null) => ChatMenuTarget | null),
  ) => {
    current = typeof next === "function" ? next(current) : next;
    updates.push(current);
  };
  function Surface({ via }: { via: ChatMenuSurface }) {
    const menu: ChatMenuTarget = { ...target, via };
    const state: ChatMenuState = {
      menu,
      setMenu,
      content: () => null,
      has: () => true,
    };
    return (
      <ChatMenu target={target} state={state}>
        <ContextMenuTrigger>Row</ContextMenuTrigger>
      </ChatMenu>
    );
  }

  await act(async () => root.render(<Surface via="context" />));
  current = { ...target, via: "dropdown" };
  await act(async () => root.render(<Surface via="dropdown" />));

  // The context surface closing must not clear the dropdown that now owns the row.
  expect(updates.at(-1)).toEqual({ ...target, via: "dropdown" });
});
