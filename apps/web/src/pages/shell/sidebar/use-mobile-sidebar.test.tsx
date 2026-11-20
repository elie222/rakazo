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
import { ComposerReplyPreview } from "../chat/chat-context";
import { useMobileSidebar } from "./use-mobile-sidebar";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw(strings, ...values),
  }),
}));
vi.mock("../../../lib/query/rpc", () => ({ rpc: { artifacts: { get: vi.fn() } } }));

const dismissReply = vi.fn();
let menuOpen = true;
let latest: ReturnType<typeof useMobileSidebar>;

function Harness() {
  latest = useMobileSidebar();
  return (
    <>
      <button type="button" data-navigation-trigger="">
        Open navigation
      </button>
      <ComposerReplyPreview author="Helper" text="Quote" onDismiss={dismissReply} />
      <DropdownMenu defaultOpen={menuOpen}>
        <DropdownMenuTrigger>More</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Rename</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
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
  dismissReply.mockClear();
  menuOpen = true;
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

it("keeps a pending reply when Escape closes the drawer", () => {
  menuOpen = false;
  mount(false);
  act(() => latest.setMobileSidebarOpen(true));

  pressEscape();

  expect(latest.mobileSidebarOpen).toBe(false);
  expect(dismissReply).not.toHaveBeenCalled();
  pressEscape();
  expect(dismissReply).toHaveBeenCalledOnce();
});

it("does not close the drawer for the legacy composition key code", () => {
  mount(false);
  act(() => latest.setMobileSidebarOpen(true));

  act(() => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", keyCode: 229, bubbles: true }),
    );
  });

  expect(latest.mobileSidebarOpen).toBe(true);
});

it("returns keyboard focus to the navigation opener after Escape", () => {
  menuOpen = false;
  mount(false);
  act(() => latest.setMobileSidebarOpen(true));
  const drawerControl = document.createElement("button");
  document.body.append(drawerControl);
  drawerControl.focus();
  pressEscape(drawerControl);
  expect(document.activeElement).toBe(container!.querySelector("[data-navigation-trigger]"));
  drawerControl.remove();
});

it("returns focus to the side panel while the navigation opener is inert", () => {
  menuOpen = false;
  mount(false);
  const trigger = container!.querySelector<HTMLButtonElement>("[data-navigation-trigger]")!;
  trigger.setAttribute("inert", "");
  const panel = document.createElement("aside");
  panel.dataset.panel = "settings";
  panel.tabIndex = -1;
  document.body.append(panel);
  act(() => latest.setMobileSidebarOpen(true));
  pressEscape();
  expect(document.activeElement).toBe(panel);
  panel.remove();
});

it("returns focus to the computer when it still covers the chat", () => {
  menuOpen = false;
  mount(false);
  const closeComputer = document.createElement("button");
  closeComputer.dataset.computerClose = "";
  document.body.append(closeComputer);
  act(() => latest.setMobileSidebarOpen(true));
  pressEscape();
  expect(document.activeElement).toBe(closeComputer);
  closeComputer.remove();
});
