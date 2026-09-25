import { describe, expect, it, vi } from "vitest";
import { closeUnterminatedFence, linkifyExplicitUrls, sanitizeMarkdownUrl } from "./markdown";

describe("linkifyExplicitUrls", () => {
  it("links bare URLs but not bare domains or file names", () => {
    const parser = { set: vi.fn(), linkify: { set: vi.fn() } };

    expect(linkifyExplicitUrls(parser)).toBe(parser);
    expect(parser.set).toHaveBeenCalledWith({ linkify: true });
    expect(parser.linkify.set).toHaveBeenCalledWith({ fuzzyLink: false });
  });
});

describe("sanitizeMarkdownUrl", () => {
  it("allows normal external links and optionally allows local links", () => {
    expect(sanitizeMarkdownUrl("https://example.com/docs")).toBe("https://example.com/docs");
    expect(sanitizeMarkdownUrl("mailto:hello@example.com")).toBe("mailto:hello@example.com");
    expect(sanitizeMarkdownUrl("/docs", true)).toBe("/docs");
    expect(sanitizeMarkdownUrl("#section", true)).toBe("#section");
  });

  it("rejects executable and embedded-data URLs", () => {
    expect(sanitizeMarkdownUrl("javascript:alert(1)", true)).toBeUndefined();
    expect(sanitizeMarkdownUrl("data:text/html,<script>alert(1)</script>", true)).toBeUndefined();
    expect(sanitizeMarkdownUrl("/docs")).toBeUndefined();
  });
});

describe("closeUnterminatedFence", () => {
  it("temporarily closes a partial streaming code fence", () => {
    expect(closeUnterminatedFence("Before\n```ts\nconst value = 1;")).toBe(
      "Before\n```ts\nconst value = 1;\n```",
    );
  });

  it("leaves complete markdown unchanged", () => {
    const markdown = "```ts\nconst value = 1;\n```\n\nDone";
    expect(closeUnterminatedFence(markdown)).toBe(markdown);
  });
});
