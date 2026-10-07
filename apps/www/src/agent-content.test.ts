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
    expect(getMarkdownDocument("/self-hosted-ai-agent/")).toContain(
      "# Self-hosted AI agent",
    );
    expect(getMarkdownDocument("/openclaw-alternative")).toContain("OpenClaw");
    expect(getMarkdownDocument("/grok-bot-alternative/")).toContain(
      "Is Grok Bot open source?",
    );
    expect(getMarkdownAlternate("/")).toBe("/index.md");
    expect(getMarkdownAlternate("/self-hosted-ai-agent/")).toBe(
      "/self-hosted-ai-agent.md",
    );
    expect(getMarkdownAlternate("/openclaw-alternative/")).toBe(
      "/openclaw-alternative.md",
    );
    expect(getMarkdownAlternate("/support/")).toBe("/support.md");
    expect(getMarkdownAlternate("/grok-bot-alternative/")).toBe(
      "/grok-bot-alternative.md",
    );
    expect(getMarkdownDocument("/terms/")).toContain("# Rakazo terms");
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
    expect(headResponse.headers.get("x-robots-tag")).toBe("noindex");
    await expect(headResponse.text()).resolves.toBe("");
  });
});
