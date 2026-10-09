import { describe, expect, it } from "vitest";
import {
  ABOUT_MARKDOWN,
  HOME_MARKDOWN,
  getMarkdownAlternate,
  getMarkdownDocument,
  markdownResponse,
  negotiateRepresentation,
} from "./agent-content";

describe("agent content negotiation", () => {
  it("serves Markdown when it is the most specific preferred representation", () => {
    expect(negotiateRepresentation("text/markdown")).toBe("markdown");
    expect(negotiateRepresentation("text/markdown, text/html;q=0.8")).toBe("markdown");
    expect(negotiateRepresentation("text/markdown, text/*")).toBe("markdown");
  });

  it("keeps browser requests on HTML and rejects unsupported representations", () => {
    expect(negotiateRepresentation(null)).toBe("html");
    expect(negotiateRepresentation("text/html,application/xhtml+xml,*/*;q=0.8")).toBe("html");
    expect(negotiateRepresentation("text/html, text/markdown;q=0.5")).toBe("html");
    expect(negotiateRepresentation("application/json")).toBe("not-acceptable");
    expect(negotiateRepresentation("text/html;q=0, text/markdown;q=0")).toBe("not-acceptable");
  });

  it("resolves trailing-slash paths and leaves unknown paths unanswered", () => {
    expect(getMarkdownDocument("/")).toBe(HOME_MARKDOWN);
    expect(getMarkdownDocument("/about/")).toBe(ABOUT_MARKDOWN);
    expect(getMarkdownAlternate("/")).toBe("/index.md");
    expect(getMarkdownAlternate("/about/")).toBe("/about.md");
    expect(getMarkdownDocument("/missing")).toBeUndefined();
    expect(getMarkdownAlternate("/missing")).toBeUndefined();
    expect(getMarkdownAlternate("/changelog")).toBeUndefined();
  });

  it("returns cache-safe Markdown responses and omits bodies for HEAD", async () => {
    const response = markdownResponse("# Rakazo\n");
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(response.headers.get("link")).toBe(
      '</llms.txt>; rel="describedby"; type="text/plain"',
    );
    expect(response.headers.get("vary")).toBe("Accept, Accept-Encoding");
    await expect(response.text()).resolves.toBe("# Rakazo\n");

    const headResponse = markdownResponse("# Rakazo\n", "HEAD", 404);
    expect(headResponse.status).toBe(404);
    expect(headResponse.headers.get("x-robots-tag")).toBe("noindex");
    await expect(headResponse.text()).resolves.toBe("");
  });
});
