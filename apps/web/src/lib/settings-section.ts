export const SETTINGS_SECTIONS = [
  "general",
  "models",
  "memory",
  "voice",
  "usage",
  "computer",
  "billing",
  "updates",
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export function isSettingsSection(value: string): value is SettingsSection {
  return (SETTINGS_SECTIONS as readonly string[]).includes(value);
}
