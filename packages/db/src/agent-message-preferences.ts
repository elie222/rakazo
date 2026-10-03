type PreferenceClient = {
  notificationPreference?: {
    findUnique(args: {
      where: { spaceId_userId: { spaceId: string; userId: string } };
      select: { markAgentMessagesUnread: true };
    }): Promise<{ markAgentMessagesUnread?: boolean } | null>;
  };
};

/** Read the account's agent-message unread preference within the active Space. */
export async function agentMessagesMarkUnread(
  prisma: PreferenceClient,
  scope: { spaceId: string; userId: string },
): Promise<boolean> {
  // The optional guard keeps isolated router tests useful with a deliberately
  // narrow fake Prisma client while real clients always expose this delegate.
  const preferences = prisma.notificationPreference;
  if (!preferences) return false;
  const preference = await preferences.findUnique({
    where: { spaceId_userId: scope },
    select: { markAgentMessagesUnread: true },
  });
  return preference?.markAgentMessagesUnread ?? false;
}
