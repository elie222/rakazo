const PROVIDER_NAMES: Record<string, string> = {
  sendblue: "iMessage",
  slack: "Slack",
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  lark: "Feishu",
  photon: "iMessage (Photon)",
  teams: "Microsoft Teams",
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

/** Whether a catalog app shares its name with one of the chat apps people can connect here. */
export function isAvailableChatApp(
  app: { name: string; slug: string },
  chatApps: readonly string[],
): boolean {
  const appNames = new Set(
    chatApps.flatMap((provider) => {
      // A named extra line mounts as "<id>-<name>" and is still that app.
      const base = Object.keys(PROVIDER_NAMES).find((id) => provider.startsWith(`${id}-`));
      return [provider, base ?? provider].flatMap((id) => [
        id.toLowerCase(),
        messagingProviderName(id).toLowerCase(),
      ]);
    }),
  );
  return [app.name, app.slug].some((name) => appNames.has(name.trim().toLowerCase()));
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

/** The chat apps a person can connect on this deployment, by provider id. */
export function availableChatApps(
  providers: readonly string[],
  installAvailable: boolean,
): string[] {
  return messagingConnectOptions(providers, installAvailable).map(({ provider }) => provider);
}

/**
 * The chat-app list in messaging settings: apps set up by a workspace install, with their
 * saved workspaces, then one row per app linked with a code, then linked accounts on apps
 * no longer offered.
 */
export function messagingChatApps<Identity extends { provider: string }>(input: {
  providers: readonly string[];
  installAvailable: boolean;
  installations: readonly { provider: string }[];
  identities: readonly Identity[];
}) {
  const options = messagingConnectOptions(input.providers, input.installAvailable);
  const installable = options
    .filter(({ method }) => method === "install")
    .map(({ provider }) => provider);
  // An app with saved workspaces is listed with them, even when it also links with a code.
  const installProviders = [
    ...new Set([...installable, ...input.installations.map(({ provider }) => provider)]),
  ];
  const linkProviders = options
    .filter(({ method, provider }) => method === "link" && !installProviders.includes(provider))
    .map(({ provider }) => provider);
  return {
    installable,
    installProviders,
    linkProviders,
    otherIdentities: input.identities.filter(
      ({ provider }) => !installProviders.includes(provider) && !linkProviders.includes(provider),
    ),
  };
}
