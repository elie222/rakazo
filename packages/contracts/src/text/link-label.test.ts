import { describe, expect, it } from "vitest";
import { linkLabel } from "./link-label.js";

describe("link labels", () => {
  it.each([
    ["https://x.com/elonmusk/status/123?s=20", "x.com/elonmusk/status/123"],
    ["https://www.example.com/", "example.com"],
    ["http://example.com", "example.com"],
    ["www.example.com/docs/", "example.com/docs"],
    ["https://example.com/caf%C3%A9#menu", "example.com/café"],
    ["https://example.com:8080/a", "example.com:8080/a"],
    [
      "https://github.com/example-org/example-repository/pull/12345/files",
      "github.com/example-org/example-reposito…",
    ],
    ["http://example.com/?q=1", "example.com"],
  ])("shortens the bare URL %s to %s", (text, label) => {
    const href = text.startsWith("www.") ? `http://${text}` : text;
    expect(linkLabel(text, href)).toBe(label);
  });

  it("treats a label that differs only in scheme or a trailing slash as bare", () => {
    expect(linkLabel("http://example.com/docs", "https://example.com/docs/")).toBe(
      "example.com/docs",
    );
  });

  it("treats a label showing the address with its escapes decoded as bare", () => {
    expect(linkLabel("https://example.com/café", "https://example.com/caf%C3%A9")).toBe(
      "example.com/café",
    );
    expect(
      linkLabel("https://example.com/\u202Etxt.exe", "https://example.com/%E2%80%AEtxt.exe"),
    ).toBe("example.com/txt.exe");
  });

  it("does not split a surrogate pair at the path truncation boundary", () => {
    const prefix = "a".repeat(26);
    const href = `https://example.com/${prefix}\u{1F600}tail`;
    expect(linkLabel(href, href)).toBe(`example.com/${prefix}…`);

    const fits = `https://example.com/${"a".repeat(25)}\u{1F600}tail`;
    expect(linkLabel(fits, fits)).toBe(`example.com/${"a".repeat(25)}\u{1F600}…`);
    const short = "https://example.com/\u{1F600}";
    expect(linkLabel(short, short)).toBe("example.com/\u{1F600}");
  });

  it("never cuts the host, however long, and trims only the path", () => {
    const host = "www.paypal.com.account-verify-login-secure-update.example.com";
    expect(linkLabel(`https://${host}/x`, `https://${host}/x`)).toBe(
      "paypal.com.account-verify-login-secure-update.example.com/x",
    );
    expect(
      linkLabel(
        `https://${host}/a/very/long/path/that/goes/on`,
        `https://${host}/a/very/long/path/that/goes/on`,
      ),
    ).toBe("paypal.com.account-verify-login-secure-update.example.com/a/very/lon…");
  });

  it("drops bidi overrides, zero-width and control characters from the path", () => {
    const href = "https://example.com/%E2%80%AEgnp.exe%E2%80%8B%E2%81%A0%EF%BB%BF%E2%81%A6x%0A";
    expect(linkLabel(href, href)).toBe("example.com/gnp.exex");
  });

  it("keeps an international host in its ASCII form", () => {
    const href = "https://аpple.com/login";
    expect(linkLabel(href, href)).toBe("xn--pple-43d.com/login");
  });

  it("keeps an author's label as written, even when it names another address", () => {
    expect(linkLabel("Post", "https://x.com/a/status/1")).toBe("Post");
    expect(linkLabel("https://other.example", "https://x.com/")).toBe("https://other.example");
  });

  it("keeps labels of links that are not websites", () => {
    expect(linkLabel("mailto:me@example.com", "mailto:me@example.com")).toBe(
      "mailto:me@example.com",
    );
    expect(linkLabel("/docs", "/docs")).toBe("/docs");
  });
});
