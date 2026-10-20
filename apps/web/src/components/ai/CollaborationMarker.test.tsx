// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ActiveBotGlyph, CollaborationMarker } from "./CollaborationMarker";

describe("collaboration transcript markers", () => {
  it("shows a left-aligned peer event with its avatar and full label", () => {
    const html = renderToString(
      <CollaborationMarker
        ariaLabel="Message from Research"
        color="#14B8A6"
        identity="research"
        label="Message from Research"
        onClick={() => undefined}
      />,
    );

    expect(html).toContain('data-testid="peer-receipt-chip"');
    expect(html).toContain('aria-label="Message from Research"');
    expect(html).toContain('class="flex justify-start"');
    expect(html).toContain('class="inline-flex max-w-full');
    expect(html).toContain('class="truncate"');
    expect(html).toContain("rakazo-organic-avatar");
    expect(html).toContain("Message from Research");
    expect(html).not.toContain("{peer}");
  });

  it("adds a collapsed toggle only when the marker has folded replies", () => {
    const marker = (replies?: { expanded: boolean; label: string; onToggle: () => void }) =>
      renderToString(
        <CollaborationMarker
          ariaLabel="Message from Research"
          color="#14B8A6"
          identity="research"
          label="Message from Research"
          onClick={() => undefined}
          replies={replies}
        />,
      );

    expect(marker()).not.toContain("aria-expanded");
    const collapsed = marker({
      expanded: false,
      label: "Expand Message from Research",
      onToggle: () => undefined,
    });
    expect(collapsed).toContain('data-testid="peer-replies-toggle"');
    expect(collapsed).toContain('data-slot="button"');
    expect(collapsed).toContain('aria-expanded="false"');
    expect(collapsed).toContain('aria-label="Expand Message from Research"');
    expect(
      marker({
        expanded: true,
        label: "Collapse Message from Research",
        onToggle: () => undefined,
      }),
    ).toContain('aria-expanded="true"');
  });

  it("reveals a sent message independently of opening the peer conversation", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    );
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const openConversation = vi.fn();
    try {
      await act(async () =>
        root.render(
          <CollaborationMarker
            ariaLabel="Messaged Chief"
            color="#14B8A6"
            identity="chief"
            label="Messaged Chief"
            onClick={openConversation}
            detail={{
              text: "Review **the proposal**",
              expandLabel: "Expand Messaged Chief",
              collapseLabel: "Collapse Messaged Chief",
            }}
          />,
        ),
      );
      const toggle = () => container.querySelector<HTMLButtonElement>("[aria-expanded]");
      expect(toggle()?.getAttribute("aria-expanded")).toBe("false");
      expect(container.textContent).not.toContain("the proposal");
      await act(async () => toggle()?.click());
      expect(toggle()?.getAttribute("aria-expanded")).toBe("true");
      expect(toggle()?.getAttribute("aria-label")).toBe("Collapse Messaged Chief");
      expect(container.querySelector("[data-testid=peer-message-detail] strong")?.textContent).toBe(
        "the proposal",
      );
      expect(container.querySelector("[data-compact]")).not.toBeNull();
      expect(openConversation).not.toHaveBeenCalled();
      await act(async () => toggle()?.click());
      expect(container.querySelector("[data-testid=peer-message-detail]")).toBeNull();
      await act(async () =>
        container.querySelector<HTMLButtonElement>("[data-testid=peer-receipt-chip]")?.click(),
      );
      expect(openConversation).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  });

  it("does not offer an empty sent message disclosure", () => {
    const html = renderToString(
      <CollaborationMarker
        ariaLabel="Messaged Chief"
        color="#14B8A6"
        identity="chief"
        label="Messaged Chief"
        onClick={() => undefined}
        detail={{
          text: "  ",
          expandLabel: "Expand Messaged Chief",
          collapseLabel: "Collapse Messaged Chief",
        }}
      />,
    );
    expect(html).not.toContain("aria-expanded");
  });

  it("animates the active bot glyph from its run status", () => {
    const html = renderToString(
      <ActiveBotGlyph
        bots={[{ botId: "research", color: "#14B8A6", status: "running" }]}
        label="Research is working"
      />,
    );

    expect(html).toContain('role="status"');
    expect(html).toContain('data-working="true"');
    expect(html).toContain("rakazo-organic-avatar-body-working");
  });
});
