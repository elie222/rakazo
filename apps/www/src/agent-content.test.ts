import { describe, expect, it } from "vitest";
import {
  ABOUT_MARKDOWN,
  AGENT_INSTRUCTIONS,
  HOME_MARKDOWN,
  getMarkdownAlternate,
  getMarkdownDocument,
  markdownResponse,
  negotiateRepresentation,
} from "./agent-content";

describe("agent content negotiation", () => {
  it("serves Markdown when it is the most specific preferred representation", () => {
    expect(negotiateRepresentation("text/markdown")).toBe("markdown");
    expect(negotiateRepresentation("text/markdown, text/html;q=0.8")).toBe(
      "markdown",
    );
    expect(negotiateRepresentation("text/markdown, text/*")).toBe("markdown");
  });

  it("keeps browser requests on HTML and rejects unsupported representations", () => {
    expect(negotiateRepresentation(null)).toBe("html");
    expect(
      negotiateRepresentation("text/html,application/xhtml+xml,*/*;q=0.8"),
    ).toBe("html");
    expect(negotiateRepresentation("text/html, text/markdown;q=0.5")).toBe(
      "html",
    );
    expect(negotiateRepresentation("application/json")).toBe("not-acceptable");
    expect(negotiateRepresentation("text/html;q=0, text/markdown;q=0")).toBe(
      "not-acceptable",
    );
  });

  it("maps canonical and trailing-slash page paths to Markdown documents", () => {
    expect(getMarkdownDocument("/")).toContain("# Rakazo");
    expect(getMarkdownDocument("/about/")).toContain("# About Rakazo");
    expect(getMarkdownAlternate("/")).toBe("/index.md");
    expect(getMarkdownAlternate("/support/")).toBe("/support.md");
    expect(getMarkdownDocument("/missing")).toBeUndefined();
    expect(getMarkdownAlternate("/missing")).toBeUndefined();
    expect(getMarkdownAlternate("/changelog")).toBeUndefined();
  });

  it("publishes specific when-to-use instructions for agents", () => {
    expect(HOME_MARKDOWN).toContain("open source Grok Bot alternative");
    expect(ABOUT_MARKDOWN).toContain("open source Grok Bot alternative");
    expect(AGENT_INSTRUCTIONS).toContain("open source Grok Bot alternative");
    expect(AGENT_INSTRUCTIONS).toContain("## When to use Rakazo");
    expect(AGENT_INSTRUCTIONS).toContain("## How an agent should use Rakazo");
    expect(AGENT_INSTRUCTIONS).toContain("Self-hosting is available now");
  });

  it("returns cache-safe Markdown responses and omits bodies for HEAD", async () => {
    const response = markdownResponse("# Rakazo\n");
    expect(response.headers.get("content-type")).toBe(
      "text/markdown; charset=utf-8",
    );
    expect(response.headers.get("link")).toBe(
      '</llms.txt>; rel="describedby"; type="text/plain"',
    );
    expect(response.headers.get("vary")).toBe("Accept, Accept-Encoding");
    await expect(response.text()).resolves.toBe("# Rakazo\n");

    const headResponse = markdownResponse("# Rakazo\n", "HEAD", 404);
    expect(headResponse.status).toBe(404);
    await expect(headResponse.text()).resolves.toBe("");
  });
});
