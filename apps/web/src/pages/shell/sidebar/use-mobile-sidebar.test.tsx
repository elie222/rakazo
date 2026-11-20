// @vitest-environment jsdom

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@rakazo/ui-web/components/ui/dropdown-menu";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useMobileSidebar } from "./use-mobile-sidebar";

let latest: ReturnType<typeof useMobileSidebar>;

function Harness() {
  latest = useMobileSidebar();
  return (
    <DropdownMenu defaultOpen>
      <DropdownMenuTrigger>More</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem>Rename</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

/** Mounts the hook under a phone (`desktop` false) or desktop (`desktop` true) layout. */
function mount(desktop: boolean) {
  window.matchMedia = vi.fn((query: string) => ({
    matches: desktop,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(<Harness />));
}

function pressEscape(target: EventTarget = document) {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  Reflect.deleteProperty(window, "matchMedia");
});

it("closes the open phone drawer on Escape", () => {
  mount(false);
  act(() => latest.setMobileSidebarOpen(true));
  expect(latest.mobileSidebarOpen).toBe(true);

  pressEscape();

  expect(latest.mobileSidebarOpen).toBe(false);
});

it("leaves the phone drawer closed when Escape is pressed with it shut", () => {
  mount(false);

  pressEscape();

  expect(latest.mobileSidebarOpen).toBe(false);
});

it("keeps the drawer open on Escape in the desktop layout", () => {
  mount(true);
  act(() => latest.setMobileSidebarOpen(true));

  pressEscape();

  expect(latest.mobileSidebarOpen).toBe(true);
});

it("does not close the drawer for an Escape another control already handled", () => {
  mount(false);
  act(() => latest.setMobileSidebarOpen(true));
  const menu = document.createElement("div");
  // A menu or dialog inside the drawer prevents the default on its own Escape handling.
  menu.addEventListener("keydown", (event) => event.preventDefault());
  document.body.append(menu);

  pressEscape(menu);
  menu.remove();

  expect(latest.mobileSidebarOpen).toBe(true);
});

it("does not close the drawer for an Escape that ends an IME composition", () => {
  mount(false);
  act(() => latest.setMobileSidebarOpen(true));

  act(() => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true }),
    );
  });

  expect(latest.mobileSidebarOpen).toBe(true);
});

it("closes an open menu on Escape and leaves the drawer open", async () => {
  mount(false);
  act(() => latest.setMobileSidebarOpen(true));
  const item = await vi.waitUntil(() =>
    [...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent === "Rename"),
  );

  pressEscape(item);

  expect(latest.mobileSidebarOpen).toBe(true);
});
