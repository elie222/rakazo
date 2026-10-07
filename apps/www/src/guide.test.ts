import { describe, expect, it } from "vitest";
import {
  COMPARISON_ROWS,
  faqPageStructuredData,
  OPENCLAW_FAQS,
  OPENCLAW_MARKDOWN,
  PUBLISHED_IMAGES_INSTALL,
  SELF_HOST_FAQS,
  SELF_HOST_MARKDOWN,
} from "./guide";

describe("guide pages", () => {
  it("keeps FAQ structured data identical to the visible answers", () => {
    const selfHost = faqPageStructuredData(SELF_HOST_FAQS);
    const openClaw = faqPageStructuredData(OPENCLAW_FAQS);

    expect(selfHost["@type"]).toBe("FAQPage");
    expect(openClaw["@type"]).toBe("FAQPage");
    expect(selfHost.mainEntity.map((item) => item.name)).toEqual(
      SELF_HOST_FAQS.map((item) => item.question),
    );
    expect(openClaw.mainEntity.map((item) => item.acceptedAnswer.text)).toEqual(
      OPENCLAW_FAQS.map((item) => item.answer),
    );
  });

  it("publishes the same facts in the Markdown guides", () => {
    for (const faq of SELF_HOST_FAQS) {
      expect(SELF_HOST_MARKDOWN).toContain(faq.question);
      expect(SELF_HOST_MARKDOWN).toContain(faq.answer);
    }
    for (const faq of OPENCLAW_FAQS) {
      expect(OPENCLAW_MARKDOWN).toContain(faq.question);
      expect(OPENCLAW_MARKDOWN).toContain(faq.answer);
    }
    for (const row of COMPARISON_ROWS) {
      expect(OPENCLAW_MARKDOWN).toContain(row.aspect);
      expect(OPENCLAW_MARKDOWN).toContain(row.rakazo);
      expect(OPENCLAW_MARKDOWN).toContain(row.openclaw);
    }
    expect(OPENCLAW_MARKDOWN).toContain("## Setup");
    expect(OPENCLAW_MARKDOWN).toContain("## Day-to-day management");
    expect(OPENCLAW_MARKDOWN).toContain("leaves the Gateway in that terminal");
    expect(OPENCLAW_MARKDOWN).toContain("Updated October 7, 2026");
    expect(OPENCLAW_MARKDOWN).toContain("just chat, like Grok Bot");
    expect(OPENCLAW_MARKDOWN).not.toContain("has to stay running");
    expect(SELF_HOST_MARKDOWN).toContain(PUBLISHED_IMAGES_INSTALL);
    expect(SELF_HOST_MARKDOWN).toContain("SANDBOX_CONTROL_VIA_LOOPBACK=true");
    expect(PUBLISHED_IMAGES_INSTALL).toContain("install-images.sh");
    expect(PUBLISHED_IMAGES_INSTALL).not.toContain("curl |");
  });
});
