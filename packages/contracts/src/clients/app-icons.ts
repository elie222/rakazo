/** Icons a person can give the installed app on their own device. The first is the one it ships with. */
export const APP_ICONS = [
  "default",
  "sunglasses",
  "headphones",
  "beanie",
  "cap",
  "tie",
  "bow-tie",
  "scarf",
  "flower",
  "sprout",
  "feet",
] as const;

export type AppIcon = (typeof APP_ICONS)[number];

export const DEFAULT_APP_ICON: AppIcon = "default";

export function isAppIcon(value: unknown): value is AppIcon {
  return (APP_ICONS as readonly unknown[]).includes(value);
}
