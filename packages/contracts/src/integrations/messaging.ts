import * as z from "zod";
import { Id } from "../ids.js";

export const MessagingLinkedIdentitySchema = z.object({
  id: Id,
  provider: z.string(),
  address: z.string(),
  botId: Id,
  botName: z.string(),
});

export const MessagingInstallationSummarySchema = z.object({
  id: Id,
  provider: z.string(),
  workspaceName: z.string(),
  botId: Id,
  botName: z.string().optional(),
});
export type MessagingInstallationSummary = z.infer<typeof MessagingInstallationSummarySchema>;
export const MessagingInstallationsStatusSchema = z.object({
  available: z.boolean(),
  /** A teammate's workspace in this space accepts the user's personal DM link. */
  personalLinkAvailable: z.boolean().optional(),
  installations: z.array(MessagingInstallationSummarySchema),
});
export type MessagingInstallationsStatus = z.infer<typeof MessagingInstallationsStatusSchema>;

export const MessagingStatusSchema = z.object({
  enabled: z.boolean(),
  /** Messaging platforms mounted on this deployment (sendblue, slack, …). */
  providers: z.array(z.string()),
  /** Where to send a link code, by provider, for platforms reached through one line. */
  addresses: z.record(z.string(), z.string()).optional(),
  /** True when unknown senders auto-provision their own accounts. */
  openSignup: z.boolean(),
  /** The caller's linked chat apps, one entry per (provider, address). */
  identities: z.array(MessagingLinkedIdentitySchema),
});
export type MessagingStatus = z.infer<typeof MessagingStatusSchema>;

export const MessagingChannelMembershipSchema = z.object({
  /** One row per linked identity: the same group can hold two of the caller's. */
  id: Id,
  channelId: Id,
  /** Which of the caller's linked chat apps this membership belongs to. */
  identityId: Id,
  provider: z.string(),
  name: z.string().nullable(),
  status: z.enum(["invited", "approved", "declined", "left"]),
  memberCount: z.number().int().nonnegative(),
});
export type MessagingChannelMembership = z.infer<typeof MessagingChannelMembershipSchema>;

export const MessagingAgentConnectionSchema = z.object({
  id: Id,
  peerBotName: z.string(),
  peerOwnerLabel: z.string(),
  status: z.enum(["pending", "approved", "declined", "revoked"]),
  /** true when the caller's bot is the target (only the target can respond). */
  incoming: z.boolean(),
});
export type MessagingAgentConnection = z.infer<typeof MessagingAgentConnectionSchema>;
