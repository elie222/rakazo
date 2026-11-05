import { mkdtempSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  instanceThemeMiddleware,
  parseInstanceTheme,
  renderInstanceThemeCss,
} from "./instance-theme";

const dir = path.resolve("/srv/theme");

function themeFolder(theme: unknown, files: Record<string, string> = {}) {
  const folder = mkdtempSync(path.join(tmpdir(), "rakazo-theme-"));
  writeFileSync(path.join(folder, "theme.json"), JSON.stringify(theme));
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(folder, name), body);
  return path.join(folder, "theme.json");
}

function serve(themeFile: string | undefined, url: string) {
  const res = { setHeader: vi.fn(), end: vi.fn() };
  const next = vi.fn();
  const warn = vi.fn();
  instanceThemeMiddleware(themeFile, warn)(
    { url } as IncomingMessage,
    res as unknown as ServerResponse,
    next,
  );
  return { res, next, warn };
}

describe("instance theme", () => {
  it("renders color overrides per appearance and font stacks", () => {
    const css = renderInstanceThemeCss(
      parseInstanceTheme(
        JSON.stringify({
          dark: { background: "#101418", cardForeground: "#EEEEEE" },
          light: { primary: "#8A4B12" },
          fonts: { sans: "Inter, system-ui, sans-serif" },
        }),
        dir,
      ),
    );
    expect(css).toContain(
      'html[data-theme="dark"] {\n  --background: #101418;\n  --card-foreground: #EEEEEE;\n}',
    );
    expect(css).toContain('html[data-theme="light"] {\n  --primary: #8A4B12;\n}');
    expect(css).toContain("html:root {\n  --font-sans: Inter, system-ui, sans-serif;\n}");
  });

  it("serves font files from the instance by their place in the list", () => {
    const theme = parseInstanceTheme(
      JSON.stringify({
        fonts: {
          sans: "Onest",
          files: [{ family: "Onest", file: "fonts/Onest.woff2", weight: "100 900" }],
        },
      }),
      dir,
    );
    expect(theme.fonts.files[0]?.file).toBe(path.join(dir, "fonts/Onest.woff2"));
    expect(renderInstanceThemeCss(theme)).toContain(
      'src: url("/instance-theme/font/0.woff2") format("woff2");\n  font-weight: 100 900;',
    );
  });

  it.each([
    [{ dark: { notAToken: "#000000" } }, "dark.notAToken is not a token"],
    [
      { dark: { background: "red; } body { display: none" } },
      "dark.background must be a hex color",
    ],
    [
      { fonts: { sans: "x; } * { background: url(https://example.com)" } },
      "fonts.sans must be a font-family list",
    ],
    [{ fonts: { files: [{ family: "Onest", file: "Onest.svg" }] } }, "fonts.files[0].file must be"],
    [{ radius: "0" }, "radius is not a theme field"],
  ])("rejects %j", (theme, message) => {
    expect(() => parseInstanceTheme(JSON.stringify(theme), dir)).toThrow(message);
  });

  it("serves an empty stylesheet when no theme is set", () => {
    const { res, next } = serve(undefined, "/instance-theme.css");
    expect(res.end).toHaveBeenCalledWith("");
    expect(next).not.toHaveBeenCalled();
  });

  it("serves the theme's stylesheet and fonts, and passes other paths on", () => {
    const file = themeFolder(
      {
        dark: { background: "#101418" },
        fonts: { files: [{ family: "Onest", file: "Onest.ttf" }] },
      },
      { "Onest.ttf": "font-bytes" },
    );
    expect(serve(file, "/instance-theme.css?v=1").res.end.mock.calls[0]?.[0]).toContain(
      "--background: #101418;",
    );
    const font = serve(file, "/instance-theme/font/0.ttf");
    expect(font.res.setHeader).toHaveBeenCalledWith("content-type", "font/ttf");
    expect(String(font.res.end.mock.calls[0]?.[0])).toBe("font-bytes");
    expect(serve(file, "/instance-theme/font/1.ttf").next).toHaveBeenCalled();
    expect(serve(file, "/instance-theme/font/..%2Ftheme.json").next).toHaveBeenCalled();
    expect(serve(file, "/").next).toHaveBeenCalled();
  });

  it("logs a broken theme and serves nothing rather than failing the page", () => {
    const file = themeFolder({ dark: { background: "nope" } });
    const { res, warn } = serve(file, "/instance-theme.css");
    expect(res.end).toHaveBeenCalledWith("");
    expect(warn).toHaveBeenCalledWith("dark.background must be a hex color");
  });
});
