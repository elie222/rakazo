// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ActiveBotGlyph, CollaborationMarker } from "./CollaborationMarker";

describe("collaboration transcript markers", () => {
  it("shows a centred peer event with its avatar and full label", () => {
    const html = renderToString(
      <CollaborationMarker
        peerName="Research"
        color="#14B8A6"
        identity="research"
        label="Message from Research"
        onClick={() => undefined}
      />,
    );

    expect(html).toContain('data-testid="peer-receipt-chip"');
    expect(html).toContain('aria-label="Message from Research"');
    expect(html).toContain('class="flex min-w-0 max-w-full justify-center"');
    expect(html).toContain('class="inline-flex max-w-full');
    expect(html).toContain("truncate font-medium");
    expect(html).toContain("rakazo-organic-avatar");
    expect(html).toContain("Message from Research");
    expect(html).not.toContain("{peer}");
    expect(html).not.toContain("peer-replies-toggle");
  });

  it("animates the active bot glyph from its run status", () => {
    const html = renderToString(
      <ActiveBotGlyph
        bots={[{ botId: "research", color: "#14B8A6", status: "running" }]}
        label="Searching the web: injury news"
      />,
    );

    expect(html).toContain('role="status"');
    expect(html).toContain('data-working="true"');
    expect(html).toContain("rakazo-organic-avatar-body-working");
  });

  it("cross-fades a new label over the last one in place", () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    const bots = [{ botId: "research", color: "#14B8A6", status: "running" }];
    act(() => root.render(<ActiveBotGlyph bots={bots} label="Reading the brief" />));
    act(() => root.render(<ActiveBotGlyph bots={bots} label="Drafting the reply" />));

    const outgoing = container.querySelector<HTMLElement>('[aria-hidden="true"].col-start-1');
    expect(outgoing?.textContent).toBe("Reading the brief");
    expect(outgoing?.className).toContain("rk-fade-out");
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Drafting the reply");

    // jsdom has no AnimationEvent, so React may listen under the prefixed name.
    act(() => {
      for (const type of ["animationend", "webkitAnimationEnd"]) {
        outgoing?.dispatchEvent(new Event(type, { bubbles: true }));
      }
    });
    expect(container.querySelector('[role="status"]')?.textContent).not.toContain(
      "Reading the brief",
    );
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
});
