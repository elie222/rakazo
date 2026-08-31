import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActiveBotGlyph, CollaborationMarker, PeerBotChip } from "./CollaborationMarker";

describe("collaboration transcript markers", () => {
  it("shows a centered Message from label and clickable bot chip", () => {
    const html = renderToString(
      <CollaborationMarker>
        Message from{" "}
        <PeerBotChip
          ariaLabel="Message from Research"
          color="#14B8A6"
          identity="research"
          botName="Research"
          onClick={() => undefined}
        />
      </CollaborationMarker>,
    );

    expect(html).toContain('data-testid="peer-receipt-chip"');
    expect(html).toContain('aria-label="Message from Research"');
    expect(html).toContain("Message from");
    expect(html).toContain("rakazo-bot-avatar");
    expect(html).toContain("Research");
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
    expect(html).toContain("rakazo-bot-avatar-ring");
  });
});
