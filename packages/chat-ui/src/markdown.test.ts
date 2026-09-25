import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { closeUnterminatedFence, linkifyExplicitUrls, sanitizeMarkdownUrl } from "./markdown";

type Token = { type: string; attrGet(name: string): string | null; children: Token[] | null };
type Parser = Parameters<typeof linkifyExplicitUrls>[0] & {
  parseInline(source: string, env: object): Token[];
};

// The markdown-it the native renderer ships; chat-ui has no direct dependency on it.
const rendererRequire = createRequire(
  createRequire(import.meta.url).resolve("@ronradtke/react-native-markdown-display/package.json"),
);
const markdownIt = rendererRequire("markdown-it") as (options: { typographer: boolean }) => Parser;

function linkHrefs(text: string) {
  const parser = linkifyExplicitUrls(markdownIt({ typographer: true }));
  return (parser.parseInline(text, {})[0]?.children ?? [])
    .filter((token) => token.type === "link_open")
    .map((token) => token.attrGet("href"));
}

describe("linkifyExplicitUrls", () => {
  it("links bare http(s) URLs and email addresses", () => {
    expect(
      linkHrefs("see http://example.test and https://example.com/a?b=1, or bob@example.com"),
    ).toEqual(["http://example.test", "https://example.com/a?b=1", "mailto:bob@example.com"]);
  });

  it("leaves file names, bare domains and unopenable schemes as text", () => {
    expect(
      linkHrefs(
        "setup.py notes.md example.com www.example.com ftp://example.com //example.com javascript:alert(1)",
      ),
    ).toEqual([]);
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
