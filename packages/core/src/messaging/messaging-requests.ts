import type {
  MessagingAgentConnection,
  MessagingChannelMembership,
  MessagingStatus,
} from "@rakazo/contracts";

/**
 * The requests waiting on the caller, each with the name of the caller's agent it asks about,
 * which only the status read knows.
 */
export function messagingRequests(input: {
  status: MessagingStatus | null | undefined;
  channels: readonly MessagingChannelMembership[];
  connections: readonly MessagingAgentConnection[];
}) {
  const identities = input.status?.identities ?? [];
  const agentWith = (match: (identity: MessagingStatus["identities"][number]) => boolean) =>
    // A deleted bot leaves its identity behind with no name.
    identities.find(match)?.botName || undefined;
  return {
    invites: input.channels
      .filter((channel) => channel.status === "invited")
      .map((channel) => ({
        channel,
        agent: agentWith((identity) => identity.id === channel.identityId),
      })),
    connectionRequests: input.connections
      .filter((connection) => connection.status === "pending" && connection.incoming)
      .map((connection) => ({
        connection,
        agent: agentWith((identity) => identity.botId === connection.botId),
      })),
  };
}
