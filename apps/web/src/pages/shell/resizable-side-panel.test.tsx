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

function Shell({ open }: { open: boolean }) {
  const [covered, setCovered] = useState(false);
  return (
    <>
      <main data-space-switch="main" inert={covered}>
        <button type="button">Message</button>
      </main>
      <ResizableSidePanel open={open} panel="settings" onCoversChat={setCovered}>
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
