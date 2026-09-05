const PROVIDER_LABELS: Record<string, string> = {
  sendblue: "iMessage",
  slack: "Slack",
  whatsapp: "WhatsApp",
  telegram: "Telegram",
};

/** User-facing name of a messaging provider (falls back to the raw id). */
export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}
