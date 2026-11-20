// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResizableSidePanel } from "./resizable-side-panel";

vi.mock("./sidebar/sidebar-layout", () => ({ useBotsSidebarWidth: () => 0 }));

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

  it("frees the chat again when the panel closes", () => {
    show(true, 390);
    expect(show(false, 390).hasAttribute("inert")).toBe(false);
  });

  it("leaves the chat alone when the panel sits beside it", () => {
    expect(show(true, 1500).hasAttribute("inert")).toBe(false);
  });
});
