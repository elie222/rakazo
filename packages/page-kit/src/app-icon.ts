import type { PageIconColor } from "@rakazo/contracts";
import { PAGE_ICON_COLORS } from "@rakazo/contracts";
import { pageAppIconGlyph, pageAppIconGradients } from "@rakazo/ui-tokens";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { pageIconComponent } from "./kit/icon.js";

const DEFAULT_ICON = "sparkles";

export type PageAppIconPage = { id: string; icon: string | null; iconColor: PageIconColor | null };

/**
 * `plate` is the desktop icon grid: a rounded plate inset in the square with room for its shadow.
 * `full` fills the square, for launchers that cut their own shape out of it.
 */
export type PageAppIconShape = "plate" | "full";

/** The color a page without one of its own gets, the same every time for that page. */
function defaultPageIconColor(pageId: string): PageIconColor {
  let hash = 0;
  for (const char of pageId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return PAGE_ICON_COLORS[hash % PAGE_ICON_COLORS.length]!;
}

/** The page's app icon as a 1024 square SVG: its color as a gradient and its page-kit glyph in white. */
export function pageAppIconSvg(page: PageAppIconPage, shape: PageAppIconShape = "plate"): string {
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
    "</linearGradient>",
    shape === "plate"
      ? '<filter id="lift" x="-10%" y="-10%" width="120%" height="130%"><feDropShadow dx="0" dy="10" stdDeviation="14" flood-opacity="0.28"/></filter></defs><rect x="100" y="100" width="824" height="824" rx="185" fill="url(#plate)" filter="url(#lift)"/>'
      : '</defs><rect width="1024" height="1024" fill="url(#plate)"/>',
    glyph,
    "</svg>",
  ].join("");
}
