const PROVIDER_NAMES: Record<string, string> = {
  sendblue: "iMessage",
  slack: "Slack",
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  lark: "Feishu",
  photon: "iMessage (Photon)",
};

/** User-facing name of a messaging provider (falls back to the raw id). */
export function messagingProviderName(provider: string): string {
  // Extra named Telegram bots mount as "telegram-<name>".
  const telegramBot = /^telegram-(.+)$/.exec(provider)?.[1];
  if (telegramBot) return `Telegram (${telegramBot})`;
  // Extra named Photon projects mount as "photon-<name>".
  const photonProject = /^photon-(.+)$/.exec(provider)?.[1];
  if (photonProject) return `iMessage (${photonProject})`;
  return PROVIDER_NAMES[provider] ?? provider;
}

/** The provider among `providers` a user names by its id or its name ("Slack"); null for none. */
export function messagingProviderNamed(name: string, providers: readonly string[]): string | null {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return null;
  return (
    providers.find(
      (provider) =>
        provider.toLowerCase() === wanted ||
        messagingProviderName(provider).toLowerCase() === wanted,
    ) ?? null
  );
}

/** Per-message provider label, narrowed to a recognized transport when available. */
export function messagingProviderLabel(provider: string, transport?: string): string {
  if (provider === "sendblue" && ["iMessage", "SMS", "RCS"].includes(transport ?? "")) {
    return transport!;
  }
  return messagingProviderName(provider);
}

/** One connection option per app; workspace authorization replaces Slack's code setup. */
export function messagingConnectOptions(
  providers: readonly string[],
  slackInstallAvailable: boolean,
) {
  const available = new Set(providers);
  if (slackInstallAvailable) available.add("slack");
  return [...available].map((provider) => ({
    provider,
    method:
      provider === "slack" && slackInstallAvailable ? ("install" as const) : ("link" as const),
  }));
}
