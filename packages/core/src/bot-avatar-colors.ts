export interface GrokColorDef {
  id: string;
  name: string;
  light: string;
  dark: string;
  eyeColor: string;
  hex: string;
}

export const GROK_COLOR_LIST: GrokColorDef[] = [
  {
    id: "white",
    name: "Staff White",
    light: "#FFFFFF",
    dark: "#CBD5E1",
    eyeColor: "#141414",
    hex: "#FFFFFF",
  },
  {
    id: "violet",
    name: "Executive Violet",
    light: "#A97EFE",
    dark: "#7C3AED",
    eyeColor: "#FFFFFF",
    hex: "#8B5CF6",
  },
  {
    id: "green",
    name: "Emerald",
    light: "#00C972",
    dark: "#059669",
    eyeColor: "#FFFFFF",
    hex: "#10B981",
  },
  {
    id: "orange",
    name: "Forge Orange",
    light: "#FF781C",
    dark: "#EA580C",
    eyeColor: "#FFFFFF",
    hex: "#F97316",
  },
  {
    id: "cyan",
    name: "Cyber Cyan",
    light: "#1CC3B0",
    dark: "#0284C7",
    eyeColor: "#FFFFFF",
    hex: "#06B6D4",
  },
  {
    id: "blue",
    name: "Cobalt Blue",
    light: "#2A92FE",
    dark: "#1D4ED8",
    eyeColor: "#FFFFFF",
    hex: "#3B82F6",
  },
  {
    id: "yellow",
    name: "Amber Gold",
    light: "#FFAF38",
    dark: "#D97706",
    eyeColor: "#141414",
    hex: "#EAB308",
  },
  {
    id: "brown",
    name: "Caramel Bronze",
    light: "#A27952",
    dark: "#78350F",
    eyeColor: "#FFFFFF",
    hex: "#8D6E63",
  },
  {
    id: "red",
    name: "Crimson Red",
    light: "#FF3E51",
    dark: "#BE123C",
    eyeColor: "#FFFFFF",
    hex: "#EF4444",
  },
  {
    id: "magenta",
    name: "Neon Pink",
    light: "#FF5EB1",
    dark: "#BE185D",
    eyeColor: "#FFFFFF",
    hex: "#EC4899",
  },
  {
    id: "gray",
    name: "Slate Silver",
    light: "#94A3B8",
    dark: "#475569",
    eyeColor: "#FFFFFF",
    hex: "#64748B",
  },
];

export const GROK_BOT_COLORS = GROK_COLOR_LIST.map((c) => c.hex);

/** Shared identity color for Avatar Studio reset/fallback (Executive Violet). */
export const DEFAULT_GROK_BOT_COLOR = GROK_COLOR_LIST.find((color) => color.id === "violet")!.hex;

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
): GrokColorDef {
  if (explicitColor) {
    const clean = explicitColor.toLowerCase();
    const foundById = GROK_COLOR_LIST.find((c) => c.id === clean || c.name.toLowerCase() === clean);
    if (foundById) return foundById;
    const foundByHex = GROK_COLOR_LIST.find((c) => c.hex.toLowerCase() === clean);
    if (foundByHex) return foundByHex;
    // If custom hex, synthesize gradient
    if (/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(explicitColor)) {
      const isBright = isColorBright(explicitColor);
      return {
        id: "custom",
        name: "Custom",
        light: explicitColor,
        dark: darkenHex(explicitColor, 20),
        eyeColor: isBright ? "#141414" : "#FFFFFF",
        hex: explicitColor,
      };
    }
  }
  const seed = (shippedHash(identity) ^ Math.imul(1, 2654435769)) >>> 0;
  const index = Math.floor(shippedRandom((seed ^ 2654435769) >>> 0)() * GROK_COLOR_LIST.length);
  return GROK_COLOR_LIST[index % GROK_COLOR_LIST.length] ?? GROK_COLOR_LIST[0]!;
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

function isColorBright(hex: string): boolean {
  const c = expandHex(hex);
  const r = Number.parseInt(c.substring(0, 2), 16) || 0;
  const g = Number.parseInt(c.substring(2, 4), 16) || 0;
  const b = Number.parseInt(c.substring(4, 6), 16) || 0;
  const brightness = (r * 299 + g * 587 + b * 114) / 1000;
  return brightness > 180;
}

function darkenHex(hex: string, percent: number): string {
  const num = Number.parseInt(expandHex(hex), 16);
  const factor = 1 - percent / 100;
  const r = Math.max(0, Math.floor(((num >> 16) & 255) * factor));
  const g = Math.max(0, Math.floor(((num >> 8) & 255) * factor));
  const b = Math.max(0, Math.floor((num & 255) * factor));
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}
