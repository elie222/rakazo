import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { darkTokens, lightTokens } from "@rakazo/ui-tokens";
import { describe, expect, it } from "vitest";

// index.html sets theme-color before any module loads, so it cannot import the
// tokens; this pins its inline fallbacks to the shared palette instead.
describe("index.html theme bootstrap", () => {
  const html = readFileSync(fileURLToPath(new URL("../../index.html", import.meta.url)), "utf8");

  it("uses the shared background tokens for theme-color", () => {
    expect(html).toContain(
      `<meta name="theme-color" content="${darkTokens.background.toLowerCase()}" />`,
    );
    expect(html).toContain(
      `theme === "light" ? "${lightTokens.background.toLowerCase()}" : "${darkTokens.background.toLowerCase()}"`,
    );
  });
});
