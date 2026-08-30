import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MessageHoverMetadata } from "./MessageHoverMetadata";

describe("MessageHoverMetadata", () => {
  it("shows the message's creation time beside its actions on hover or focus", () => {
    const createdAt = new Date(2026, 7, 21, 18, 14).toISOString();
    const html = renderToStaticMarkup(
      <MessageHoverMetadata createdAt={createdAt}>
        <div data-testid="message-actions-pill" />
      </MessageHoverMetadata>,
    );

    expect(html).toContain(
      `<time dateTime="${createdAt}" class="text-[11px] tabular-nums text-[#85858A]">6:14 PM</time>`,
    );
    expect(html.indexOf("<time")).toBeLessThan(html.indexOf('data-testid="message-actions-pill"'));
    expect(html).toContain("group-hover/message:opacity-100");
    expect(html).toContain("focus-within:opacity-100");
  });
});
