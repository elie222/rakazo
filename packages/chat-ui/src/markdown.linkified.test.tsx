import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LinkifiedText } from "./markdown.web";

describe("web user message links", () => {
  it("renders explicit urls as links and leaves markdown markers literal", () => {
    const html = renderToStaticMarkup(
      <LinkifiedText>{"# Title\n**important** https://example.com/docs."}</LinkifiedText>,
    );

    expect(html).toContain("# Title");
    expect(html).toContain("**important**");
    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('rel="noreferrer noopener"');
    // A bare address shows as host and path, after its site icon.
    expect(html).toContain('<bdi class="rk-chat-link-label">example.com/docs</bdi></a>.');
    expect(html).not.toContain("<h1");
    expect(html).not.toContain("<strong");
  });
});
