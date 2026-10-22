import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { darkTokens, lightTokens } from "@rakazo/ui-tokens";
import { describe, expect, it } from "vitest";

// index.html sets theme-color before any module loads, so it cannot import the
// tokens; this pins its fallbacks to the shared palette instead.
describe("index.html theme bootstrap", () => {
  const read = (relative: string) =>
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
  const html = read("../../index.html");
  const script = read("../../public/theme.js");

  it("uses the shared background tokens for theme-color", () => {
    expect(html).toContain(
      `<meta name="theme-color" content="${darkTokens.background.toLowerCase()}" />`,
    );
    expect(script).toContain(
      `theme === "light" ? "${lightTokens.background.toLowerCase()}" : "${darkTokens.background.toLowerCase()}"`,
    );
  });

  it("loads the bootstrap as a file so the CSP needs no inline scripts", () => {
    expect(html).toContain('<script src="/theme.js"></script>');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
  });
});
