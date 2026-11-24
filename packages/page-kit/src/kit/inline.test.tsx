import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { inlineMarkup } from "./inline.js";

const html = (text: string) => renderToStaticMarkup(<p>{inlineMarkup(text)}</p>);

describe("bare links in inline text", () => {
  it("keeps smart double quotes out of a bare link beside prose", () => {
    const markup = html("See “https://example.com/agenda”next.");
    expect(markup).toContain('href="https://example.com/agenda"');
    expect(markup).toContain("“<a");
    expect(markup).toContain(">https://example.com/agenda</a>”next.");
  });

  it("keeps smart single quotes and the sentence period out of a www link", () => {
    const markup = html("See ‘www.example.com/agenda’.");
    expect(markup).toContain('href="https://www.example.com/agenda"');
    expect(markup).toContain("‘<a");
    expect(markup).toContain(">www.example.com/agenda</a>’.");
  });

  it("preserves a different smart quote inside the URL path", () => {
    const markup = html("Read “https://example.com/O’Connor”.");
    expect(markup).toContain('href="https://example.com/O%E2%80%99Connor"');
    expect(markup).toContain(">https://example.com/O’Connor</a>”.");
  });

  it("preserves encoded quote characters inside the link", () => {
    const markup = html("Read “https://example.com/agenda%E2%80%9D”.");
    expect(markup).toContain('href="https://example.com/agenda%E2%80%9D"');
    expect(markup).toContain(">https://example.com/agenda%E2%80%9D</a>”.");
  });

  it("does not trim smart quotes from unwrapped URLs", () => {
    const markup = html("Read https://example.com/O’Connor.");
    expect(markup).toContain('href="https://example.com/O%E2%80%99Connor"');
    expect(markup).toContain(">https://example.com/O’Connor</a>.");
  });

  it("still keeps paired parentheses and excludes sentence punctuation", () => {
    const markup = html('Read "https://example.com/agenda_(Q4)".');
    expect(markup).toContain('href="https://example.com/agenda_(Q4)"');
    expect(markup).toContain(">https://example.com/agenda_(Q4)</a>&quot;.");
  });
});
