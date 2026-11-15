import { describe, expect, it } from "vitest";
import {
  getMarkdownAlternate,
  getMarkdownDocument,
  getStaticMarkdownPath,
  negotiateRepresentation,
} from "./agent-content";

describe("negotiateRepresentation", () => {
  it.each([
    [null, "html"],
    ["", "html"],
    ["text/html,application/xhtml+xml,*/*;q=0.8", "html"],
    ["text/markdown", "markdown"],
    ["text/markdown, text/html;q=0.9", "markdown"],
    ["text/html, text/markdown", "html"],
    ["text/*, text/markdown", "markdown"],
    ["text/markdown;q=0", "html"],
    ["application/json", "html"],
    ["image/avif, image/webp", "html"],
  ])("answers %j with %s", (accept, expected) => {
    expect(negotiateRepresentation(accept)).toBe(expected);
  });
});

describe("getStaticMarkdownPath", () => {
  it.each([
    ["/blog/", "/blog.md"],
    ["/blog/self-host-an-ai-agent/", "/blog/self-host-an-ai-agent.md"],
    ["/pricing", "/pricing.md"],
    ["/docs/", "/docs.md"],
    ["/docs/routines/", "/docs/routines.md"],
    ["/integrations/", "/integrations.md"],
    ["/integrations/gmail/", "/integrations/gmail.md"],
  ])("serves %s from %s", (pathname, expected) => {
    expect(getStaticMarkdownPath(pathname)).toBe(expected);
  });

  it.each([
    "/blog/guides/",
    "/docs/getting-started/",
    "/docs/not-a-doc/",
    "/integrations/gmail/claim/",
    "/about/",
    "/",
  ])("has no static file for %s", (pathname) => {
    expect(getStaticMarkdownPath(pathname)).toBeUndefined();
  });
});

describe("getMarkdownAlternate", () => {
  it("covers pages rendered in the middleware and static files", () => {
    expect(getMarkdownAlternate("/")).toBe("/index.md");
    expect(getMarkdownAlternate("/about/")).toBe("/about.md");
    expect(getMarkdownAlternate("/blog/self-host-an-ai-agent/")).toBe(
      "/blog/self-host-an-ai-agent.md",
    );
    expect(getMarkdownAlternate("/blog/guides/")).toBeUndefined();
  });

  it("keeps static pages out of the in-middleware map", () => {
    expect(getMarkdownDocument("/pricing/")).toBeUndefined();
    expect(getMarkdownDocument("/about/")).toContain("# About Rakazo");
  });
});
