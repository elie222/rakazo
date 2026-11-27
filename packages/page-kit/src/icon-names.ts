export const PAGE_ICON_GROUPS = {
  travel: [
    "plane",
    "train-front",
    "bus",
    "car",
    "bike",
    "ship",
    "luggage",
    "ticket",
    "hotel",
    "bed",
    "tent",
    "map",
    "map-pin",
    "route",
    "compass",
    "globe",
    "flag",
  ],
  places: ["house", "building-2", "store", "landmark", "hospital", "mountain", "tree-pine"],
  time: ["calendar", "calendar-check", "clock", "timer", "hourglass"],
  money: [
    "wallet",
    "credit-card",
    "banknote",
    "coins",
    "receipt",
    "shopping-cart",
    "shopping-bag",
    "tag",
    "percent",
    "gift",
  ],
  charts: [
    "chart-line",
    "chart-column",
    "chart-pie",
    "trending-up",
    "trending-down",
    "activity",
    "target",
    "database",
  ],
  status: [
    "check",
    "circle-check",
    "x",
    "circle-x",
    "circle-alert",
    "triangle-alert",
    "info",
    "circle-help",
    "shield-check",
    "lock",
    "bell",
    "star",
    "heart",
    "thumbs-up",
    "sparkles",
    "zap",
    "trophy",
  ],
  people: ["user", "users", "user-plus", "handshake", "briefcase", "graduation-cap", "stethoscope"],
  talk: ["mail", "phone", "message-circle", "send", "video", "share-2"],
  food: ["utensils", "coffee", "wine", "pizza", "cake", "cooking-pot", "salad"],
  weather: [
    "sun",
    "moon",
    "cloud",
    "cloud-sun",
    "cloud-rain",
    "cloud-snow",
    "snowflake",
    "wind",
    "umbrella",
    "thermometer",
    "droplet",
    "leaf",
  ],
  devices: ["laptop", "monitor", "smartphone", "server", "wifi", "code", "bot", "camera"],
  files: [
    "file",
    "file-text",
    "folder",
    "clipboard-list",
    "book-open",
    "newspaper",
    "image",
    "link",
    "external-link",
    "download",
  ],
  things: [
    "package",
    "truck",
    "key",
    "lightbulb",
    "rocket",
    "pill",
    "heart-pulse",
    "dumbbell",
    "music",
    "film",
    "wrench",
    "settings",
  ],
  actions: [
    "search",
    "pencil",
    "trash-2",
    "plus",
    "refresh-cw",
    "list-checks",
    "arrow-right",
    "arrow-left",
    "arrow-up-right",
    "chevron-right",
  ],
} as const;

export type PageIconName = (typeof PAGE_ICON_GROUPS)[keyof typeof PAGE_ICON_GROUPS][number];

export const PAGE_ICONS: readonly PageIconName[] = Object.values(PAGE_ICON_GROUPS).flat();

const ICONS: ReadonlySet<string> = new Set(PAGE_ICONS);

export const isPageIcon = (name: unknown): name is PageIconName =>
  typeof name === "string" && ICONS.has(name);

export const MIRRORED_ICONS: ReadonlySet<PageIconName> = new Set([
  "arrow-right",
  "arrow-left",
  "arrow-up-right",
  "chevron-right",
  "external-link",
  "send",
]);

const words = (name: string) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        previous[j]! + 1,
        row[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = row;
  }
  return previous[b.length]!;
}

export function closeIconNames(name: string): PageIconName[] {
  const wanted = words(name);
  const joined = wanted.join("-");
  return PAGE_ICONS.map((icon) => {
    const own = icon.split("-");
    const shared = wanted.filter((word) =>
      own.some((part) => part === word || (part.length > 2 && word.includes(part))),
    ).length;
    return { icon, shared, distance: distance(joined, icon) };
  })
    .filter(({ shared, distance }) => shared > 0 || distance <= 2)
    .sort((a, b) => b.shared - a.shared || a.distance - b.distance)
    .slice(0, 3)
    .map(({ icon }) => icon);
}
