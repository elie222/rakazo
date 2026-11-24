// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResizableSidePanel } from "./resizable-side-panel";

vi.mock("./sidebar/sidebar-layout", () => ({ useBotsSidebarWidth: () => sidebarWidth }));

let sidebarWidth: number;
let host: HTMLDivElement;
let root: Root;

let overlays: boolean[];

function Shell({ open }: { open: boolean }) {
  const [covered, setCovered] = useState(false);
  return (
    <>
      <main data-space-switch="main" inert={covered}>
        <button type="button">Message</button>
      </main>
      <ResizableSidePanel
        open={open}
        panel="settings"
        onCoversChat={setCovered}
        onOverlays={(value) => overlays.push(value)}
      >
        <button type="button">Close panel</button>
      </ResizableSidePanel>
    </>
  );
}

function show(open: boolean, width: number) {
  window.innerWidth = width;
  act(() => {
    root.render(<Shell open={open} />);
  });
  return host.querySelector<HTMLElement>('[data-space-switch="main"]')!;
}

describe("ResizableSidePanel", () => {
  beforeEach(() => {
    sidebarWidth = 0;
    overlays = [];
    i18n.load("en", {});
    i18n.activate("en");
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("makes the covered chat inert while the panel is open over it", () => {
    expect(show(true, 390).hasAttribute("inert")).toBe(true);
  });

  it("moves focus from the chat to the panel when the panel covers it", () => {
    const message = show(false, 390).querySelector("button")!;
    message.focus();
    expect(document.activeElement).toBe(message);

    show(true, 390);

    expect(document.activeElement).toBe(host.querySelector('[data-testid="side-panel"]'));
  });

  it("frees the chat again when the panel closes", () => {
    show(true, 390);
    expect(show(false, 390).hasAttribute("inert")).toBe(false);
  });

  it("keeps the visible chat interactive when the sidebar is off canvas", () => {
    sidebarWidth = 316;
    expect(show(true, 600).hasAttribute("inert")).toBe(false);
  });

  it("reports a panel that floats over the chat while the chat stays interactive", () => {
    sidebarWidth = 316;
    expect(show(true, 800).hasAttribute("inert")).toBe(false);
    expect(overlays.at(-1)).toBe(true);
  });

  it("reports a panel that sits beside the chat as not floating", () => {
    sidebarWidth = 316;
    show(true, 1400);
    expect(overlays.at(-1)).toBe(false);
  });

  it("makes the chat inert when the overlay covers nearly all of it beside the sidebar", () => {
    sidebarWidth = 460;
    expect(show(true, 800).hasAttribute("inert")).toBe(true);
  });

  it("keeps the visible chat interactive when the overlay partially covers it beside the sidebar", () => {
    sidebarWidth = 316;
    expect(show(true, 800).hasAttribute("inert")).toBe(false);
  });

  it("leaves the chat alone when the panel sits beside it", () => {
    const message = show(false, 1500).querySelector("button")!;
    message.focus();

    expect(show(true, 1500).hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(message);
  });
});

describe("ResizableSidePanel keyboard", () => {
  function Harness({ panel }: { panel: "settings" | "routine" }) {
    const [open, setOpen] = useState(false);
    const [menuOpen, setMenuOpen] = useState(false);
    return (
      <>
        <button type="button" data-testid="opener" onClick={() => setOpen(true)}>
          Bot
        </button>
        <input data-testid="elsewhere" />
        <ResizableSidePanel
          open={open}
          panel={panel}
          onEscape={panel === "settings" ? () => setOpen(false) : undefined}
        >
          {open ? (
            <>
              <button type="button" data-testid="close" onClick={() => setOpen(false)}>
                Close panel
              </button>
              <textarea data-testid="field" />
              <button
                type="button"
                data-testid="menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen(true)}
                onKeyDown={(event) => {
                  if (event.key !== "Escape" || !menuOpen) return;
                  event.preventDefault();
                  setMenuOpen(false);
                }}
              >
                Menu
              </button>
            </>
          ) : null}
        </ResizableSidePanel>
      </>
    );
  }

  const byId = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
  const panelOpen = () => host.querySelector('[data-testid="close"]') !== null;
  function pressEscape(target: Element) {
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => {
      target.dispatchEvent(event);
    });
    return event;
  }
  function openFromButton(panel: "settings" | "routine") {
    sidebarWidth = 0;
    window.innerWidth = 1500;
    act(() => root.render(<Harness panel={panel} />));
    byId("opener").focus();
    act(() => byId("opener").click());
    byId("close").focus();
  }

  beforeEach(() => {
    sidebarWidth = 0;
    i18n.load("en", {});
    i18n.activate("en");
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("closes Chat Details on Escape and returns focus to the opener", () => {
    openFromButton("settings");
    expect(pressEscape(byId("close")).defaultPrevented).toBe(true);
    expect(panelOpen()).toBe(false);
    expect(document.activeElement).toBe(byId("opener"));
  });

  it("returns focus to the opener when the close button is used", () => {
    openFromButton("settings");
    act(() => byId("close").click());
    expect(document.activeElement).toBe(byId("opener"));
  });

  it("leaves a form panel open on Escape", () => {
    openFromButton("routine");
    pressEscape(byId("close"));
    expect(panelOpen()).toBe(true);
  });

  it("closes only the inner menu on the first Escape and Chat Details on the second", () => {
    openFromButton("settings");
    const menu = byId("menu");
    menu.focus();
    act(() => menu.click());
    expect(pressEscape(menu).defaultPrevented).toBe(true);
    expect(menu.getAttribute("aria-expanded")).toBe("false");
    expect(panelOpen()).toBe(true);
    expect(pressEscape(menu).defaultPrevented).toBe(true);
    expect(panelOpen()).toBe(false);
  });

  it("does not take focus the user moved elsewhere", () => {
    openFromButton("settings");
    byId("elsewhere").focus();
    act(() => byId("close").click());
    expect(panelOpen()).toBe(false);
    expect(document.activeElement).toBe(byId("elsewhere"));
  });

  it("keeps the panel open on Escape in an editable field", () => {
    openFromButton("settings");
    byId("field").focus();
    pressEscape(byId("field"));
    expect(panelOpen()).toBe(true);
  });

  it("ignores Escape while focus is outside the panel", () => {
    openFromButton("settings");
    byId("elsewhere").focus();
    pressEscape(byId("elsewhere"));
    expect(panelOpen()).toBe(true);
  });
});
