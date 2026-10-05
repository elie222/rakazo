import { describe, expect, it } from "vitest";
import { SANDBOXED_ARTIFACT_CSP, withSandboxedArtifactCsp } from "./artifact-sandbox.js";

describe("withSandboxedArtifactCsp", () => {
  it("prepends a CSP meta tag ahead of the document", () => {
    const html = "<!doctype html><html><head></head><body>hi</body></html>";
    const wrapped = withSandboxedArtifactCsp(html);
    expect(wrapped.startsWith('<meta http-equiv="Content-Security-Policy"')).toBe(true);
    expect(wrapped).toContain(html);
  });

  it("embeds the shared restrictive policy", () => {
    const wrapped = withSandboxedArtifactCsp("<p>content</p>");
    expect(wrapped).toContain(SANDBOXED_ARTIFACT_CSP);
    expect(wrapped).toContain("default-src 'none'");
  });

  it("allows no network loads, only inline and data content", () => {
    expect(SANDBOXED_ARTIFACT_CSP).toContain("img-src data:;");
    expect(SANDBOXED_ARTIFACT_CSP).toContain("font-src data:;");
    expect(SANDBOXED_ARTIFACT_CSP).not.toContain("https:");
  });

  it("does not attempt to parse or rewrite an attacker-controlled <head>", () => {
    // A fake head in a comment must not confuse placement — the meta is
    // always prepended, never spliced in based on a regex match.
    const html = "<!-- <head> --><script>evil()</script>";
    const wrapped = withSandboxedArtifactCsp(html);
    expect(wrapped.startsWith('<meta http-equiv="Content-Security-Policy"')).toBe(true);
    expect(wrapped.endsWith(html)).toBe(true);
  });
});
