import { describe, expect, it } from "vitest";
import {
  htmlPageViewerDocument,
  PAGE_COPY_MAX_LENGTH,
  pageCopyRequest,
  pageLinkRequest,
  pageReplyText,
  pageViewerDocument,
  SANDBOXED_ARTIFACT_CSP,
  withSandboxedArtifactCsp,
} from "./artifact-sandbox.js";

describe("withSandboxedArtifactCsp", () => {
  it("keeps a leading doctype ahead of the CSP meta tag", () => {
    const html = "<!doctype html><html><head></head><body>hi</body></html>";
    const wrapped = withSandboxedArtifactCsp(html);
    expect(wrapped.toLowerCase().startsWith("<!doctype html>")).toBe(true);
    const metaAt = wrapped.indexOf('<meta http-equiv="Content-Security-Policy"');
    expect(metaAt).toBe("<!doctype html>".length);
    expect(wrapped.indexOf("<html>")).toBeGreaterThan(metaAt);
    expect(wrapped).toContain(SANDBOXED_ARTIFACT_CSP);
  });

  it("adds a standards-mode doctype when the fragment has none", () => {
    const wrapped = withSandboxedArtifactCsp("<p>content</p>");
    expect(wrapped.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(wrapped).toContain(SANDBOXED_ARTIFACT_CSP);
    expect(wrapped).toContain("default-src 'none'");
    expect(wrapped.endsWith("<p>content</p>")).toBe(true);
  });

  it("puts the CSP ahead of content that precedes a doctype", () => {
    const html = "<script>evil()</script><!doctype html>";
    expect(withSandboxedArtifactCsp(html).startsWith("<!DOCTYPE html><meta")).toBe(true);
  });

  it("allows no network loads, only inline and data content", () => {
    expect(SANDBOXED_ARTIFACT_CSP).toContain("img-src data:;");
    expect(SANDBOXED_ARTIFACT_CSP).toContain("font-src data:;");
    expect(SANDBOXED_ARTIFACT_CSP).toContain("form-action 'none'");
    // A page's own sound or video plays from embedded data or a blob it made, never a URL.
    expect(SANDBOXED_ARTIFACT_CSP).toContain("media-src data: blob:;");
    expect(SANDBOXED_ARTIFACT_CSP).not.toContain("https:");
    expect(SANDBOXED_ARTIFACT_CSP).not.toContain("http:");
  });

  it("does not insert the CSP tag inside a quoted doctype", () => {
    const html = '<!DOCTYPE html SYSTEM "x>y"><script>evil()</script>';
    const wrapped = withSandboxedArtifactCsp(html);
    expect(wrapped.startsWith("<!DOCTYPE html><meta")).toBe(true);
    expect(wrapped.endsWith(html)).toBe(true);
    expect(wrapped).not.toContain("x<meta");
  });

  it("does not splice the meta tag into a comment that looks like <head>", () => {
    const html = "<!-- <head> --><script>evil()</script>";
    const wrapped = withSandboxedArtifactCsp(html);
    expect(wrapped.startsWith("<!DOCTYPE html><meta")).toBe(true);
    expect(wrapped.endsWith(html)).toBe(true);
  });
});

describe("htmlPageViewerDocument", () => {
  const page = (body: string) =>
    `<!DOCTYPE html><html><head><title>Report</title></head><body>${body}</body></html>`;

  it("keeps the author's document and adds only the CSP and the reader's theme", () => {
    const html = htmlPageViewerDocument({
      html: page("<h1>Report</h1><script>run()</script>"),
      theme: "dark",
    });
    expect(html.startsWith("<!DOCTYPE html><meta")).toBe(true);
    expect(html).toContain("<h1>Report</h1><script>run()</script>");
    expect(html).toContain(SANDBOXED_ARTIFACT_CSP);
    expect(html).toContain('r.dataset.theme="dark"');
    expect(html).toContain('r.style.colorScheme="dark"');
    // The bridge follows the author's markup, so the page's own scripts run first.
    expect(html.indexOf("<h1>Report</h1>")).toBeLessThan(html.indexOf("rakazo-page:height"));
    expect(html.indexOf("</html>")).toBeLessThan(html.indexOf("rakazo-page:height"));
  });

  it("reports its height and hands web links to the app, never navigating the frame away", () => {
    const html = htmlPageViewerDocument({ html: page(""), theme: "light" });
    expect(html).toContain('"rakazo-page:height"');
    expect(html).toContain("new ResizeObserver(report)");
    // The body's height, not the document element's: the latter is never below the frame
    // viewport, so an inline page could grow but never shrink back to its content.
    expect(html).toContain("var h=b.scrollHeight;");
    expect(html).not.toContain("Math.max(b.scrollHeight");
    expect(html).toContain('"rakazo-page:open-link"');
    expect(html).toContain("event.preventDefault()");
    expect(html).toContain('url.protocol!=="http:"');
  });

  it("gives a fragment a document and appends the bridge after its content", () => {
    const html = htmlPageViewerDocument({ html: "<p>content</p>", theme: "light" });
    expect(html.startsWith("<!DOCTYPE html><meta")).toBe(true);
    expect(html).toContain("<p>content</p><script>");
  });

  it("does not splice the bridge into a closing tag the page writes as text", () => {
    const page = `<html><body><script>const closing = "</body>";</script></body></html>`;
    const html = htmlPageViewerDocument({ html: page, theme: "light" });
    // The author's document is untouched, and the bridge follows it whole.
    expect(html).toContain(page);
    expect(html).toContain("</html><script>");
  });

  it("sets the reader's language only when the page does not declare one", () => {
    expect(htmlPageViewerDocument({ html: page(""), theme: "light", lang: "ja" })).toContain(
      'if(!r.lang)r.lang="ja"',
    );
    // A page that sets its own lang is left alone.
    const declared = htmlPageViewerDocument({
      html: '<html lang="fr"><body>x</body></html>',
      theme: "light",
      lang: "ja",
    });
    expect(declared).toContain('if(!r.lang)r.lang="ja"');
  });

  it("keeps text that tries to close the bridge script inert", () => {
    const html = htmlPageViewerDocument({
      html: page("<script>const x = '</script><script>steal()</script>';</script>"),
      theme: "light",
      lang: "</script><script>steal()</script>",
    });
    // The author's script is theirs; the bridge never interpolates page text.
    expect(html).not.toContain('r.lang="</script>');
  });
});

describe("pageViewerDocument", () => {
  const base = { runtime: "", code: "", theme: "dark" as const, errorTitle: "x" };

  it("marks a touch screen, and offers replies only when the host has a composer for them", () => {
    expect(pageViewerDocument({ ...base, touch: true })).toContain("<html data-touch>");
    expect(pageViewerDocument({ ...base, reply: true, touch: true })).toContain(
      "<html data-touch data-reply>",
    );
    expect(pageViewerDocument(base)).toContain("<html><head>");
  });

  it("carries page code that tries to close its script as inert JSON", () => {
    const code =
      'const App = () => React.createElement(Text, null, "</script><script>steal()</script><!--");';
    const html = pageViewerDocument({
      runtime: "window.RakazoPage={mount(){}};",
      code,
      theme: "light",
      errorTitle: "Couldn't show",
    });
    const boot = html.slice(
      html.indexOf("RakazoPage.mount(") + "RakazoPage.mount(".length,
      -"</script></body></html>".length - 1,
    );
    expect(html.match(/<\/script>/g)).toHaveLength(2);
    expect(html).not.toContain("<!--");
    expect(JSON.parse(boot)).toEqual({ code, theme: "light", errorTitle: "Couldn't show" });
    const ja = pageViewerDocument({ ...base, lang: "ja" });
    expect(JSON.parse(ja.match(/RakazoPage\.mount\((.*)\)<\/script>/)![1]!).lang).toBe("ja");
    // The reader's language is not the content's, so it never becomes the frame's lang or dir.
    expect(ja).toContain("<html><head>");
  });

  it("paints the host surface behind the page on screen and refuses anything but a hex colour", () => {
    expect(pageViewerDocument({ ...base, surface: "#1f1f1f" })).toContain(
      "<style>@media screen{:root[data-theme]{--background:#1f1f1f}}</style>",
    );
    const injected = pageViewerDocument({ ...base, surface: "red}</style><script>x()</script>" });
    expect(injected).not.toContain("<style>");
    expect(injected).not.toContain("x()");
  });
});

describe("pageReplyText", () => {
  it("keeps a reply on one line, up to 300 characters", () => {
    expect(pageReplyText("  Pick\n\toption   B ")).toBe("Pick option B");
    expect(pageReplyText("x".repeat(300))).toHaveLength(300);
    for (const unusable of ["x".repeat(301), " \n ", 7, undefined]) {
      expect(pageReplyText(unusable)).toBeNull();
    }
  });
});

describe("pageCopyRequest", () => {
  it("passes a page's text to copy and nothing else, up to the cap", () => {
    const copy = { type: "rakazo-page:copy", id: "c1", text: "yes" };
    expect(pageCopyRequest(copy)).toEqual({ id: "c1", text: "yes" });
    const longest = "x".repeat(PAGE_COPY_MAX_LENGTH);
    expect(pageCopyRequest({ ...copy, text: longest })).toEqual({ id: "c1", text: longest });
    expect(pageCopyRequest({ ...copy, text: `${longest}x` })).toBeNull();
    expect(pageCopyRequest({ ...copy, text: "" })).toBeNull();
    expect(pageCopyRequest({ ...copy, text: 7 })).toBeNull();
    expect(pageCopyRequest({ ...copy, id: "" })).toBeNull();
    expect(pageCopyRequest({ ...copy, id: "i".repeat(65) })).toBeNull();
    expect(pageCopyRequest({ ...copy, type: "rakazo-page:paste" })).toBeNull();
    expect(pageCopyRequest("rakazo-page:copy")).toBeNull();
  });
});

describe("pageLinkRequest", () => {
  it("opens only web and mail links a page asks for", () => {
    const ask = (url: unknown, type = "rakazo-page:open-link") => ({ type, url });
    expect(pageLinkRequest(ask("https://example.com/a?b=1"))).toBe("https://example.com/a?b=1");
    expect(pageLinkRequest(ask("http://example.com"))).toBe("http://example.com/");
    expect(pageLinkRequest(ask("mailto:rj@example.com"))).toBe("mailto:rj@example.com");
    for (const refused of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "data:text/html,<b>x</b>",
      "file:///etc/passwd",
      "rakazo://settings",
      "intent://x#Intent;end",
      "/relative",
      `https://example.com/${"a".repeat(5000)}`,
      42,
    ]) {
      expect(pageLinkRequest(ask(refused))).toBeNull();
    }
    expect(pageLinkRequest(ask("https://example.com", "rakazo-page:other"))).toBeNull();
    expect(pageLinkRequest(null)).toBeNull();
  });
});
