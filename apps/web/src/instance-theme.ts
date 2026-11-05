import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { ResolvedAppearance, WebColorTokens } from "@rakazo/ui-tokens";
import { cssVariableName, webDarkTokens } from "@rakazo/ui-tokens";

export const INSTANCE_THEME_PATH = "/instance-theme.css";
const FONT_PATH = "/instance-theme/font/";

const COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
// Font stacks only: names, quotes, commas and spaces. No url(), braces or semicolons.
const FONT_STACK = /^[\w\s"',-]+$/;
const FAMILY = /^[\w -]+$/;
const WEIGHT = /^\d{3}(?: \d{3})?$/;
const FONT_TYPES: Record<string, { format: string; mime: string }> = {
  ".woff2": { format: "woff2", mime: "font/woff2" },
  ".woff": { format: "woff", mime: "font/woff" },
  ".ttf": { format: "truetype", mime: "font/ttf" },
  ".otf": { format: "opentype", mime: "font/otf" },
};

type Overlay = Partial<Record<keyof WebColorTokens, string>>;

/** A font file the instance serves itself, so the app's `font-src 'self'` still holds. */
type FontFile = { family: string; file: string; weight?: string };

export type InstanceTheme = {
  dark: Overlay;
  light: Overlay;
  fonts: { sans?: string; mono?: string; files: FontFile[] };
};

function readOverlay(value: unknown, where: string): Overlay {
  if (value === undefined) return {};
  if (!value || typeof value !== "object") throw new Error(`${where} must be an object`);
  const overlay: Overlay = {};
  for (const [key, color] of Object.entries(value)) {
    if (!Object.hasOwn(webDarkTokens, key)) throw new Error(`${where}.${key} is not a token`);
    if (typeof color !== "string" || !COLOR.test(color)) {
      throw new Error(`${where}.${key} must be a hex color`);
    }
    overlay[key as keyof WebColorTokens] = color;
  }
  return overlay;
}

function readFont(value: unknown, where: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !FONT_STACK.test(value)) {
    throw new Error(`${where} must be a font-family list`);
  }
  return value;
}

/** Font files resolve against the theme file's folder, so a theme and its fonts mount together. */
function readFontFiles(value: unknown, themeDir: string): FontFile[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("fonts.files must be a list");
  return value.map((entry: unknown, index) => {
    const where = `fonts.files[${index}]`;
    const { family, file, weight } = (entry ?? {}) as Record<string, unknown>;
    if (typeof family !== "string" || !FAMILY.test(family)) {
      throw new Error(`${where}.family must be a font name`);
    }
    if (typeof file !== "string" || !FONT_TYPES[path.extname(file).toLowerCase()]) {
      throw new Error(`${where}.file must be a .woff2, .woff, .ttf or .otf file`);
    }
    if (weight !== undefined && (typeof weight !== "string" || !WEIGHT.test(weight))) {
      throw new Error(`${where}.weight must look like "400" or "100 900"`);
    }
    return { family, file: path.resolve(themeDir, file), weight };
  });
}

export function parseInstanceTheme(source: string, themeDir: string): InstanceTheme {
  const raw: unknown = JSON.parse(source);
  if (!raw || typeof raw !== "object") throw new Error("theme must be an object");
  const { dark, light, fonts, ...rest } = raw as Record<string, unknown>;
  const unknownKey = Object.keys(rest)[0];
  if (unknownKey) throw new Error(`${unknownKey} is not a theme field`);
  const fontObject = (fonts ?? {}) as Record<string, unknown>;
  return {
    dark: readOverlay(dark, "dark"),
    light: readOverlay(light, "light"),
    fonts: {
      sans: readFont(fontObject.sans, "fonts.sans"),
      mono: readFont(fontObject.mono, "fonts.mono"),
      files: readFontFiles(fontObject.files, themeDir),
    },
  };
}

function block(selector: string, lines: string[]): string {
  return lines.length ? `${selector} {\n${lines.join("\n")}\n}` : "";
}

function colorLines(overlay: Overlay): string[] {
  return (Object.keys(overlay) as (keyof WebColorTokens)[]).map(
    (token) => `  ${cssVariableName(token)}: ${overlay[token]};`,
  );
}

function fontFace(font: FontFile, index: number): string {
  const ext = path.extname(font.file).toLowerCase();
  return block("@font-face", [
    `  font-family: "${font.family}";`,
    `  src: url("${FONT_PATH}${index}${ext}") format("${FONT_TYPES[ext]?.format}");`,
    ...(font.weight ? [`  font-weight: ${font.weight};`] : []),
    "  font-display: swap;",
  ]);
}

/** Loaded after the app stylesheet; `html[...]` outranks the token blocks' `:root, [data-theme]`. */
export function renderInstanceThemeCss(theme: InstanceTheme): string {
  const appearances: ResolvedAppearance[] = ["dark", "light"];
  const fonts = [
    theme.fonts.sans && `  --font-sans: ${theme.fonts.sans};`,
    theme.fonts.mono && `  --font-mono: ${theme.fonts.mono};`,
  ].filter((line): line is string => Boolean(line));
  return [
    ...theme.fonts.files.map(fontFace),
    block("html:root", fonts),
    ...appearances.map((appearance) =>
      block(`html[data-theme="${appearance}"]`, colorLines(theme[appearance])),
    ),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function loadTheme(file: string): InstanceTheme {
  return parseInstanceTheme(readFileSync(file, "utf8"), path.dirname(path.resolve(file)));
}

/**
 * Serves `RAKAZO_THEME`'s stylesheet and font files. The file is re-read per request so a
 * self-hoster sees edits on reload; a bad file is logged and serves nothing.
 */
export function instanceThemeMiddleware(
  themeFile: string | undefined,
  warn: (reason: string) => void,
) {
  return (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const pathname = req.url?.split("?", 1)[0] ?? "";
    if (pathname === INSTANCE_THEME_PATH) {
      res.setHeader("content-type", "text/css; charset=utf-8");
      res.setHeader("cache-control", "no-cache");
      let css = "";
      if (themeFile) {
        try {
          css = renderInstanceThemeCss(loadTheme(themeFile));
        } catch (error) {
          warn(error instanceof Error ? error.message : String(error));
        }
      }
      res.end(css);
      return;
    }
    if (!themeFile || !pathname.startsWith(FONT_PATH)) return next();
    // Only indexes into the theme's own list are served, never a path from the URL.
    const index = Number.parseInt(pathname.slice(FONT_PATH.length), 10);
    try {
      const font = loadTheme(themeFile).fonts.files[index];
      if (!font) return next();
      const body = readFileSync(font.file);
      res.setHeader("content-type", FONT_TYPES[path.extname(font.file).toLowerCase()]?.mime ?? "");
      res.setHeader("cache-control", "no-cache");
      res.end(body);
    } catch (error) {
      warn(error instanceof Error ? error.message : String(error));
      next();
    }
  };
}
