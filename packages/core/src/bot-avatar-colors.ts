import type { BotColorDef } from "@rakazo/contracts";
import { BOT_COLOR_LIST, parseBotAvatarValue } from "@rakazo/contracts";

/** Shared identity color for Avatar Studio reset/fallback (Executive Violet). */
export const DEFAULT_BOT_AVATAR_COLOR = BOT_COLOR_LIST.find((color) => color.id === "violet")!.hex;

/** The bots the invite artwork draws, in order; white would vanish on a light page. */
export const INVITE_AVATAR_COLORS: readonly string[] = (
  ["violet", "green", "orange", "cyan", "blue"] as const
).map((id) => BOT_COLOR_LIST.find((color) => color.id === id)!.hex);

export function shippedHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  }
  return hash >>> 0;
}

export function shippedRandom(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value + 1831565813) | 0;
    let next = Math.imul(value ^ (value >>> 15), 1 | value);
    next = (next + Math.imul(next ^ (next >>> 7), 61 | next)) ^ next;
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

export function resolvePersonaColorDef(
  identity: string,
  explicitColor?: string | null,
): BotColorDef {
  if (explicitColor) {
    const clean = explicitColor.toLowerCase();
    const foundById = BOT_COLOR_LIST.find((c) => c.id === clean || c.name.toLowerCase() === clean);
    if (foundById) return foundById;
    const foundByHex = BOT_COLOR_LIST.find(
      (c) => c.hex.toLowerCase() === clean || c.previousHex?.toLowerCase() === clean,
    );
    if (foundByHex) return foundByHex;
    if (/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(explicitColor)) {
      return { id: "custom", name: "Custom", hex: explicitColor };
    }
  }
  const seed = (shippedHash(identity) ^ Math.imul(1, 2654435769)) >>> 0;
  const index = Math.floor(shippedRandom((seed ^ 2654435769) >>> 0)() * BOT_COLOR_LIST.length);
  return BOT_COLOR_LIST[index % BOT_COLOR_LIST.length] ?? BOT_COLOR_LIST[0]!;
}

/**
 * Your messages in a bot's chat wear that bot's exact avatar color under white text. Photo and
 * white avatars keep the neutral bubble.
 */
export function chatUserBubbleColors(
  avatarValue: string,
  identity: string,
): { background: string; foreground: string } | undefined {
  const parsed = parseBotAvatarValue(avatarValue);
  if (parsed.kind === "image") return undefined;
  const def = resolvePersonaColorDef(identity, parsed.kind === "other" ? undefined : parsed.color);
  if (def.id === "white") return undefined;
  return { background: `#${expandHex(def.hex)}`.toUpperCase(), foreground: "#FFFFFF" };
}

/**
 * Which ink a bot's eyes take. They are cut-outs in the page color (dark in dark mode, light in
 * light mode), unless the body is pale or dark enough that the cut-out would fade in one theme;
 * then they stay the ink that contrasts with the body. Amber, emerald and cyan are pale enough.
 */
export function botEyeTone(bodyHex: string): "page" | "dark" | "light" {
  if (contrastRatio(bodyHex, "#FFFFFF") < 2.4) return "dark";
  if (contrastRatio(bodyHex, "#000000") < 2) return "light";
  return "page";
}

/** The eye ink {@link botEyeTone} picks, on a page with these two colors. */
export function botEyeInk(bodyColor: string, page: { background: string; foreground: string }) {
  const tone = botEyeTone(bodyColor);
  if (tone === "page") return page.background;
  const [darker, lighter] =
    contrastRatio(page.background, "#FFFFFF") > contrastRatio(page.foreground, "#FFFFFF")
      ? [page.background, page.foreground]
      : [page.foreground, page.background];
  return tone === "dark" ? darker : lighter;
}

/** WCAG contrast ratio between two hex colors. */
export function contrastRatio(a: string, b: string): number {
  const [high, low] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return ((high ?? 0) + 0.05) / ((low ?? 0) + 0.05);
}

function relativeLuminance(hex: string): number {
  const c = expandHex(hex);
  const [r, g, b] = [0, 2, 4].map((offset) => {
    const channel = (Number.parseInt(c.substring(offset, offset + 2), 16) || 0) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

function expandHex(hex: string): string {
  const c = hex.replace("#", "");
  if (c.length === 3) {
    const r = c[0] ?? "0";
    const g = c[1] ?? "0";
    const b = c[2] ?? "0";
    return `${r}${r}${g}${g}${b}${b}`;
  }
  return c;
}
