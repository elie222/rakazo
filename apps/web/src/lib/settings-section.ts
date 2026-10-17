export const SETTINGS_SECTIONS = [
  "general",
  "models",
  "memory",
  "voice",
  "confirmations",
  "usage",
  "computer",
  "billing",
  "updates",
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];
