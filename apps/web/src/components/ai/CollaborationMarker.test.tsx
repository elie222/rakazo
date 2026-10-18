import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
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
