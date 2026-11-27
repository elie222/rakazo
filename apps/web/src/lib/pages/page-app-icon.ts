import type { PageIconColor } from "@rakazo/contracts";
import { PAGE_ICON_COLORS } from "@rakazo/contracts";
import { pageAppIconGlyph, pageAppIconGradients } from "@rakazo/ui-tokens";
import { createElement } from "react";

const DEFAULT_ICON = "sparkles";
const SIZES = [16, 32, 64, 128, 256, 512, 1024];

/** The color a page without one of its own gets, the same every time for that page. */
export function defaultPageIconColor(pageId: string): PageIconColor {
  let hash = 0;
  for (const char of pageId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return PAGE_ICON_COLORS[hash % PAGE_ICON_COLORS.length]!;
}

/**
 * The page's app icon as SVG on the macOS icon grid: a rounded plate inset in a 1024 square with
 * room for its shadow, and the page-kit glyph in white. Loaded only when someone installs a page.
 */
export async function pageAppIconSvg(page: {
  id: string;
  icon: string | null;
  iconColor: PageIconColor | null;
}): Promise<string> {
  const [{ renderToStaticMarkup }, { pageIconComponent }] = await Promise.all([
    import("react-dom/server"),
    import("@rakazo/page-kit/icon"),
  ]);
  const Glyph = pageIconComponent(page.icon) ?? pageIconComponent(DEFAULT_ICON)!;
  const glyph = renderToStaticMarkup(
    createElement(Glyph, {
      width: 440,
      height: 440,
      x: 292,
      y: 292,
      color: pageAppIconGlyph,
      strokeWidth: 2,
    }),
  );
  const [top, bottom] = pageAppIconGradients[page.iconColor ?? defaultPageIconColor(page.id)];
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">',
    '<defs><linearGradient id="plate" x1="0" y1="0" x2="0" y2="1">',
    `<stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/>`,
    '</linearGradient><filter id="lift" x="-10%" y="-10%" width="120%" height="130%">',
    '<feDropShadow dx="0" dy="10" stdDeviation="14" flood-opacity="0.28"/></filter></defs>',
    '<rect x="100" y="100" width="824" height="824" rx="185" fill="url(#plate)" filter="url(#lift)"/>',
    glyph,
    "</svg>",
  ].join("");
}

export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** The icon drawn as PNG at every size an app icon file holds, as base64. */
export async function pageAppIconPngs(svg: string): Promise<{ size: number; png: string }[]> {
  const image = new Image();
  image.src = svgDataUrl(svg);
  await image.decode();
  return SIZES.map((size) => {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser cannot draw the app icon.");
    context.drawImage(image, 0, 0, size, size);
    return { size, png: canvas.toDataURL("image/png").slice("data:image/png;base64,".length) };
  });
}
